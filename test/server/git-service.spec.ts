import { describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createGitService, createRunner, type RunCommand } from '../../server/git-service.js';

const execFileAsync = promisify(execFile);

const head = 'a'.repeat(40);
const remote = 'b'.repeat(40);

function fixture(overrides: Record<string, string> = {}) {
  const outputs: Record<string, string> = {
    'git symbolic-ref --quiet --short HEAD': 'feature/review\n',
    'git rev-parse HEAD': `${head}\n`,
    'git ls-remote --heads origin refs/heads/feature/review': `${remote}\trefs/heads/feature/review\n`,
    'gh pr list --head feature/review --state open --limit 1 --json number': '[]',
  };
  Object.assign(outputs, overrides);
  const run = vi.fn<RunCommand>(async (command, args) => {
    const key = [command, ...args].join(' ');
    if (!(key in outputs)) throw new Error(`Unexpected command: ${key}`);
    return outputs[key];
  });
  return { service: createGitService(run), run, outputs };
}

describe('git service', () => {
  it('merges only the reviewed head of an open, ready PR', async () => {
    const { service, run } = fixture({
      'gh pr view 143 --json state,isDraft,headRefOid': JSON.stringify({ state: 'OPEN', isDraft: false, headRefOid: head }),
      [`gh api -X PUT repos/{owner}/{repo}/pulls/143/merge -f sha=${head} -f merge_method=merge`]: '{"merged":true}',
    });
    await expect(service.mergePr(143, head)).resolves.toEqual({ number: 143 });
    expect(run).toHaveBeenCalledWith('gh', ['api', '-X', 'PUT', 'repos/{owner}/{repo}/pulls/143/merge', '-f', `sha=${head}`, '-f', 'merge_method=merge']);
  });

  it('rejects a draft or changed PR before merging', async () => {
    const { service, run, outputs } = fixture({
      'gh pr view 143 --json state,isDraft,headRefOid': JSON.stringify({ state: 'OPEN', isDraft: true, headRefOid: head }),
    });
    await expect(service.mergePr(143, head)).rejects.toMatchObject({ status: 409 });
    outputs['gh pr view 143 --json state,isDraft,headRefOid'] = JSON.stringify({ state: 'OPEN', isDraft: false, headRefOid: remote });
    await expect(service.mergePr(143, head)).rejects.toMatchObject({ status: 409 });
    outputs['gh pr view 143 --json state,isDraft,headRefOid'] = JSON.stringify({ state: 'MERGED', isDraft: false, headRefOid: head });
    await expect(service.mergePr(143, head)).rejects.toMatchObject({ status: 409 });
    expect(run).not.toHaveBeenCalledWith('gh', expect.arrayContaining(['PUT']));
  });

  it('does not report success when GitHub declines a merge', async () => {
    const { service } = fixture({
      'gh pr view 143 --json state,isDraft,headRefOid': JSON.stringify({ state: 'OPEN', isDraft: false, headRefOid: head }),
      [`gh api -X PUT repos/{owner}/{repo}/pulls/143/merge -f sha=${head} -f merge_method=merge`]: '{"merged":false}',
    });
    await expect(service.mergePr(143, head)).rejects.toMatchObject({ status: 409 });
  });
  it('loads changed files and commits from GitHub for a selected PR', async () => {
    const { service, run } = fixture({
      'gh api repos/{owner}/{repo}/pulls/143/files?per_page=100 --paginate --slurp': JSON.stringify([[{ filename: 'src/a.ts', sha: head, previous_filename: 'src/old.ts', status: 'renamed', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+new' }, { filename: 'image.png', status: 'added', additions: 0, deletions: 0 }]]),
      'gh api repos/{owner}/{repo}/pulls/143/commits?per_page=100 --paginate --slurp': JSON.stringify([[{ sha: head, commit: { message: 'Improve review\n\nMore detail', author: { name: 'Alice', date: '2026-10-16T10:00:00Z' } }, author: { login: 'alice' } }]]),
    });
    await expect(service.prFiles(143)).resolves.toEqual({ files: [
      { path: 'src/a.ts', sha: head, oldPath: 'src/old.ts', status: 'renamed', additions: 1, deletions: 1, patchAvailable: true, isBinary: false, hunks: [{ header: '@@ -1 +1 @@', lines: [{ kind: 'remove', oldNumber: 1, newNumber: null, content: 'old' }, { kind: 'add', oldNumber: null, newNumber: 1, content: 'new' }] }] },
      { path: 'image.png', sha: '', status: 'added', additions: 0, deletions: 0, patchAvailable: false, isBinary: false, hunks: [] },
    ] });
    await expect(service.prCommits(143)).resolves.toEqual({ commits: [{ sha: head, subject: 'Improve review', author: 'Alice', authoredAt: '2026-10-16T10:00:00Z' }] });
    expect(run).toHaveBeenCalledWith('gh', ['api', 'repos/{owner}/{repo}/pulls/143/files?per_page=100', '--paginate', '--slurp']);
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('handles files without a patch and commits with missing author metadata', async () => {
    const { service } = fixture({
      'gh api repos/{owner}/{repo}/pulls/8/files?per_page=100 --paginate --slurp': JSON.stringify([[{ filename: 'large.txt' }], [{ filename: 'src/new.ts', patch: '@@ -0,0 +1 @@\n+new' }]]),
      'gh api repos/{owner}/{repo}/pulls/8/commits?per_page=100 --paginate --slurp': JSON.stringify([[{ sha: head, commit: { message: 'Update' } }]]),
    });
    await expect(service.prFiles(8)).resolves.toMatchObject({ files: [
      { path: 'large.txt', sha: '', status: 'modified', additions: 0, deletions: 0, patchAvailable: false },
      { path: 'src/new.ts', sha: '', status: 'modified', additions: 0, deletions: 0, patchAvailable: true },
    ] });
    await expect(service.prCommits(8)).resolves.toEqual({ commits: [
      { sha: head, subject: 'Update', author: 'Unknown', authoredAt: '' },
    ] });
  });
  it('lists recent PRs and derives aggregate check status', async () => {
    const { service, run } = fixture({
      'gh pr list --state all --search sort:updated-desc --limit 100 --json number,title,state,isDraft,headRefName,baseRefName,updatedAt,url,reviewDecision,statusCheckRollup': JSON.stringify([
        { number: 3, title: 'Third', state: 'OPEN', isDraft: true, headRefName: 'feature', baseRefName: 'dev', updatedAt: '2026-10-16T00:00:00Z', url: 'https://github.com/o/r/pull/3', reviewDecision: 'REVIEW_REQUIRED', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS' }] },
        { number: 2, title: 'Second', state: 'MERGED', isDraft: false, headRefName: 'old', baseRefName: 'dev', updatedAt: '2026-10-15T00:00:00Z', url: 'https://github.com/o/r/pull/2', reviewDecision: '', statusCheckRollup: [{ state: 'FAILURE' }] },
        { number: 1, title: 'First', state: 'CLOSED', isDraft: false, headRefName: 'first', baseRefName: 'dev', updatedAt: '2026-10-14T00:00:00Z', url: 'https://github.com/o/r/pull/1', reviewDecision: null, statusCheckRollup: [] },
      ]),
    });
    await expect(service.listPrs('all')).resolves.toMatchObject({ items: [
      { number: 3, reviewDecision: 'REVIEW_REQUIRED', checkStatus: 'pending' },
      { number: 2, reviewDecision: null, checkStatus: 'failure' },
      { number: 1, checkStatus: 'none' },
    ] });
    expect(run).toHaveBeenCalledWith('gh', ['pr', 'list', '--state', 'all', '--search', 'sort:updated-desc', '--limit', '100', '--json', expect.any(String)]);
  });

  it('normalizes missing optional GitHub list fields', async () => {
    const { service } = fixture({
      'gh pr list --state all --search sort:updated-desc --limit 100 --json number,title,state,isDraft,headRefName,baseRefName,updatedAt,url,reviewDecision,statusCheckRollup': JSON.stringify([{ number: 8 }]),
    });
    await expect(service.listPrs('all')).resolves.toEqual({ items: [{
      number: 8, title: '', state: '', isDraft: false, headRefName: '', baseRefName: '',
      updatedAt: '', url: '', reviewDecision: null, checkStatus: 'none',
    }] });
  });

  it('returns PR detail with conversation, review and inline comments', async () => {
    const { service } = fixture({
      'gh pr view 143 --json number,title,state,isDraft,headRefName,baseRefName,updatedAt,url,reviewDecision,statusCheckRollup,body,comments,reviews,headRefOid': JSON.stringify({
        number: 143, title: 'Review', state: 'OPEN', isDraft: false, headRefName: 'feature', baseRefName: 'dev', updatedAt: '2026-10-16T00:00:00Z', url: 'https://github.com/o/r/pull/143', reviewDecision: 'APPROVED', statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }], body: 'Description',
        comments: [{ author: { login: 'alice' }, body: 'Conversation', createdAt: '2026-10-16T01:00:00Z', url: 'https://github.com/comment/1' }, { author: null, body: 'Deleted account', createdAt: '2026-10-16T01:30:00Z', url: 'https://github.com/comment/2' }],
        reviews: [{ author: { login: 'bob' }, body: 'Review body', submittedAt: '2026-10-16T02:00:00Z', url: 'https://github.com/review/1' }, { author: { login: 'bob' }, body: '  ' }],
      }),
      'gh api repos/{owner}/{repo}/pulls/143/comments?per_page=100 --paginate --slurp': JSON.stringify([[{ user: { login: 'carol' }, body: 'Inline', created_at: '2026-10-16T03:00:00Z', html_url: 'https://github.com/inline/1', path: 'src/a.ts', line: 12 }]]),
    });
    await expect(service.prDetail(143)).resolves.toMatchObject({
      pr: { number: 143, body: 'Description', checkStatus: 'success', checks: [{ name: 'test' }] },
      comments: [
        { kind: 'conversation', author: 'alice', body: 'Conversation' },
        { kind: 'conversation', author: 'Unknown', body: 'Deleted account' },
        { kind: 'review', author: 'bob', body: 'Review body' },
        { kind: 'inline', author: 'carol', body: 'Inline', path: 'src/a.ts', line: 12 },
      ],
    });
  });

  it('handles an empty inline-comment page', async () => {
    const { service } = fixture({
      'gh pr view 1 --json number,title,state,isDraft,headRefName,baseRefName,updatedAt,url,reviewDecision,statusCheckRollup,body,comments,reviews,headRefOid': JSON.stringify({ number: 1, title: 'Empty', state: 'OPEN', isDraft: false, headRefName: 'x', baseRefName: 'dev', updatedAt: '', url: '', statusCheckRollup: [], body: '', comments: [], reviews: [], headRefOid: head }),
      'gh api repos/{owner}/{repo}/pulls/1/comments?per_page=100 --paginate --slurp': '[[]]',
    });
    await expect(service.prDetail(1)).resolves.toMatchObject({ comments: [] });
  });
  it('returns branch metadata and no PR', async () => {
    const { service, run } = fixture();
    await expect(service.summary()).resolves.toEqual({ branch: 'feature/review', headSha: head, pr: null });
    expect(run).not.toHaveBeenCalledWith('git', ['rev-list', '--count', 'origin/dev..HEAD']);
  });

  it('accepts a Git branch name containing #', async () => {
    const branch = 'feat/#412-delete-account';
    const { service } = fixture({
      'git symbolic-ref --quiet --short HEAD': `${branch}\n`,
      [`git ls-remote --heads origin refs/heads/${branch}`]: `${head}\trefs/heads/${branch}\n`,
    });
    await expect(service.pushStatus()).resolves.toEqual({ needsPush: false, branch, headSha: head, remoteSha: head });
  });

  it('queries GitHub by selected PR state', async () => {
    const { service, run } = fixture({
      'gh pr list --state merged --search sort:updated-desc --limit 100 --json number,title,state,isDraft,headRefName,baseRefName,updatedAt,url,reviewDecision,statusCheckRollup': '[]',
    });
    await expect(service.listPrs('merged')).resolves.toEqual({ items: [] });
    expect(run).toHaveBeenCalledWith('gh', ['pr', 'list', '--state', 'merged', '--search', 'sort:updated-desc', '--limit', '100', '--json', expect.any(String)]);
  });

  it('lists GitHub branches across pages without using local git', async () => {
    const { service, run } = fixture({
      'gh api repos/{owner}/{repo}/branches?per_page=100 --paginate --slurp': JSON.stringify([
        [{ name: 'dev', commit: { sha: head } }],
        [{ name: 'feature/remote', commit: { sha: remote } }],
      ]),
    });
    await expect(service.listBranches()).resolves.toEqual({ branches: [
      { name: 'dev', sha: head }, { name: 'feature/remote', sha: remote },
    ] });
    expect(run).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalledWith('git', expect.anything());
  });

  it('creates a draft PR from an existing remote branch without touching local git', async () => {
    const { run, outputs } = fixture({
      'gh api repos/{owner}/{repo}/branches?per_page=100 --paginate --slurp': JSON.stringify([[{ name: 'feature/remote', commit: { sha: remote } }]]),
      'gh pr list --head feature/remote --base dev --state open --limit 1 --json number': '[]',
      'gh pr create --base dev --head feature/remote --title New --body Body --draft': 'https://github.com/a/b/pull/144\n',
      'gh pr view 144 --json number,title,body,url,state,isDraft,reviewDecision,statusCheckRollup': JSON.stringify({
        number: 144, title: 'New', body: 'Body', url: 'https://github.com/a/b/pull/144', state: 'OPEN', isDraft: true, reviewDecision: null, statusCheckRollup: [],
      }),
    });
    const creating = createGitService(async (command, args) => {
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'create') {
        outputs['gh pr list --head feature/remote --base dev --state open --limit 1 --json number'] = '[{"number":144}]';
      }
      return run(command, args);
    });
    await expect(creating.createRemotePr({ headBranch: 'feature/remote', title: 'New', body: 'Body', draft: true })).resolves.toMatchObject({ number: 144, isDraft: true });
    expect(run).toHaveBeenCalledWith('gh', ['pr', 'create', '--base', 'dev', '--head', 'feature/remote', '--title', 'New', '--body', 'Body', '--draft']);
    expect(run).not.toHaveBeenCalledWith('git', expect.anything());
  });

  it('rejects a missing branch and an existing open PR for dev', async () => {
    const { service, run } = fixture({
      'gh api repos/{owner}/{repo}/branches?per_page=100 --paginate --slurp': JSON.stringify([[{ name: 'feature/remote', commit: { sha: remote } }]]),
      'gh pr list --head feature/remote --base dev --state open --limit 1 --json number': '[{"number":143}]',
      'gh pr view 143 --json number,title,body,url,state,isDraft,reviewDecision,statusCheckRollup': JSON.stringify({
        number: 143, title: 'Existing', body: '', url: 'https://github.com/a/b/pull/143', state: 'OPEN', isDraft: false, statusCheckRollup: [],
      }),
    });
    await expect(service.createRemotePr({ headBranch: 'missing', title: 'New', body: '', draft: false })).rejects.toMatchObject({ status: 400 });
    await expect(service.createRemotePr({ headBranch: 'feature/remote', title: 'New', body: '', draft: false })).rejects.toMatchObject({ status: 409 });
    expect(run).not.toHaveBeenCalledWith('gh', expect.arrayContaining(['create']));
  });

  it('reads PR review and CI data', async () => {
    const { service } = fixture({
      'gh pr list --head feature/review --state open --limit 1 --json number': '[{"number":143}]',
      'gh pr view 143 --json number,title,body,url,state,isDraft,reviewDecision,statusCheckRollup': JSON.stringify({
        number: 143, title: 'Review', body: 'Body', url: 'https://github.com/a/b/pull/143', state: 'OPEN', isDraft: false,
        reviewDecision: 'APPROVED', statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      }),
    });
    await expect(service.summary()).resolves.toMatchObject({ pr: { number: 143, reviewDecision: 'APPROVED', checks: [{ name: 'test', conclusion: 'SUCCESS' }] } });
    await expect(service.createPr({ title: 'New', body: '', draft: false, expectedHeadSha: head })).rejects.toMatchObject({ status: 409 });
  });

  it('checks remote head before push and PR creation', async () => {
    const { service, run } = fixture();
    await expect(service.pushStatus()).resolves.toEqual({ needsPush: true, branch: 'feature/review', headSha: head, remoteSha: remote });
    await expect(service.push(remote)).rejects.toMatchObject({ status: 409 });
    await expect(service.createPr({ title: 'New', body: '', draft: false, expectedHeadSha: head })).rejects.toMatchObject({ status: 409 });
    expect(run).not.toHaveBeenCalledWith('git', expect.arrayContaining(['push']));
  });

  it('reports an unpushed branch and rejects a detached HEAD', async () => {
    const { service } = fixture({ 'git ls-remote --heads origin refs/heads/feature/review': '' });
    await expect(service.pushStatus()).resolves.toMatchObject({ needsPush: true, remoteSha: null });
    const detached = fixture({ 'git symbolic-ref --quiet --short HEAD': '' });
    await expect(detached.service.summary()).rejects.toMatchObject({ status: 409 });
  });

  it('pushes HEAD and creates a draft PR after remote verification', async () => {
    const { service, run, outputs } = fixture({
      [`git push origin ${head}:refs/heads/feature/review`]: '',
      'git branch --set-upstream-to=origin/feature/review feature/review': '',
      'git ls-remote --heads origin refs/heads/feature/review': `${head}\trefs/heads/feature/review\n`,
      'gh pr create --base dev --head feature/review --title New --body Body --draft': 'https://github.com/a/b/pull/144\n',
      'gh pr view 144 --json number,title,body,url,state,isDraft,reviewDecision,statusCheckRollup': JSON.stringify({
        number: 144, title: 'New', body: 'Body', url: 'https://github.com/a/b/pull/144', state: 'OPEN', isDraft: true, reviewDecision: '', statusCheckRollup: [],
      }),
    });
    await expect(service.push(head)).resolves.toMatchObject({ remoteSha: head });
    const creating = createGitService(async (command, args) => {
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'create') {
        outputs['gh pr list --head feature/review --state open --limit 1 --json number'] = '[{"number":144}]';
      }
      return run(command, args);
    });
    await expect(creating.createPr({ title: 'New', body: 'Body', draft: true, expectedHeadSha: head })).resolves.toMatchObject({ number: 144, isDraft: true });
    expect(run).toHaveBeenCalledWith('git', ['push', 'origin', `${head}:refs/heads/feature/review`]);
    expect(run).toHaveBeenCalledWith('git', ['branch', '--set-upstream-to=origin/feature/review', 'feature/review']);
    expect(run).toHaveBeenCalledWith('gh', ['pr', 'create', '--base', 'dev', '--head', 'feature/review', '--title', 'New', '--body', 'Body', '--draft']);
  });

  it('sets upstream tracking after pushing the verified commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pr-review-git-'));
    const local = join(root, 'local');
    const remoteRepo = join(root, 'remote.git');
    const git = (args: string[], cwd = local) => execFileAsync('git', args, { cwd });
    try {
      await execFileAsync('git', ['init', '--bare', remoteRepo]);
      await execFileAsync('git', ['init', '-b', 'feature/review', local]);
      await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'test']);
      await git(['remote', 'add', 'origin', remoteRepo]);
      const { stdout: sha } = await git(['rev-parse', 'HEAD']);
      const service = createGitService(createRunner(local));
      await expect(service.push(sha.trim())).resolves.toMatchObject({ remoteSha: sha.trim() });
      const { stdout: upstream } = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
      expect(upstream.trim()).toBe('origin/feature/review');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
