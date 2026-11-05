import { describe, expect, it, vi } from 'vitest';
import { createCompareService } from '../../server/compare-service.js';
import type { RunCommand } from '../../server/git-service.js';

const base = 'a'.repeat(40);
const head = 'b'.repeat(40);
const branches = [[{ name: 'dev', commit: { sha: base } }], [{ name: 'feature/#123', commit: { sha: head } }]];

describe('branch comparison', () => {
  it('compares GitHub branch SHAs and preserves files, patches and paginated commits', async () => {
    const run = vi.fn<RunCommand>(async (_command, args) => args[1].includes('/branches?') ? JSON.stringify(branches) : args[1].includes('/pulls?') ? '[]' : JSON.stringify([
      { ahead_by: 2, behind_by: 1, total_commits: 2, commits: [{ sha: head, commit: { message: 'First\nmore', author: { name: 'Alice', date: '2026-01-01' } } }], files: [{ filename: 'new.ts', previous_filename: 'old.ts', status: 'renamed', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+new' }, { filename: 'binary.png' }] },
      { commits: [{ sha: base, commit: { message: 'Second' } }] },
    ]));
    const service = createCompareService(run);
    const result = await service.compare('dev', 'feature/#123');
    expect(result).toMatchObject({ base: { name: 'dev', sha: base }, head: { name: 'feature/#123', sha: head }, aheadBy: 2, behindBy: 1, totalCommits: 2, filesLimited: false, commits: [{ subject: 'First', author: 'Alice' }, { subject: 'Second', author: 'Unknown' }], files: [{ path: 'new.ts', oldPath: 'old.ts', patchAvailable: true, hunks: [{ lines: [{ content: 'old' }, { content: 'new' }] }] }, { path: 'binary.png', patchAvailable: false }] });
    expect(run).toHaveBeenCalledWith('gh', ['api', `repos/{owner}/{repo}/compare/${base}...${head}?per_page=100`, '--paginate', '--slurp']);
  });

  it('rejects equal, missing and changed branches before creating a PR', async () => {
    const run = vi.fn<RunCommand>(async () => JSON.stringify(branches));
    const service = createCompareService(run);
    await expect(service.compare('dev', 'dev')).rejects.toMatchObject({ status: 400 });
    await expect(service.compare('dev', 'missing')).rejects.toMatchObject({ status: 400 });
    await expect(service.createPr({ base: 'dev', head: 'feature/#123', title: 'New', body: '', draft: false, expectedBaseSha: head, expectedHeadSha: head })).rejects.toMatchObject({ status: 409 });
    await expect(service.createPr({ base: 'dev', head: 'feature/#123', title: 'New', body: '', draft: false, expectedBaseSha: base, expectedHeadSha: base })).rejects.toMatchObject({ status: 409 });
    expect(run).not.toHaveBeenCalledWith('gh', expect.arrayContaining(['POST']));
  });

  it('creates the PR using the reviewed branch tips', async () => {
    const run = vi.fn<RunCommand>(async (_command, args) => args.includes('POST') ? JSON.stringify({ number: 144, html_url: 'https://github.com/example/pull/144' }) : args[1].includes('/pulls?') ? '[]' : JSON.stringify(branches));
    const service = createCompareService(run);
    await expect(service.createPr({ base: 'dev', head: 'feature/#123', title: 'New', body: 'Description', draft: true, expectedBaseSha: base, expectedHeadSha: head })).resolves.toMatchObject({ number: 144 });
    expect(run).toHaveBeenCalledWith('gh', ['api', '-X', 'POST', 'repos/{owner}/{repo}/pulls', '-f', 'base=dev', '-f', 'head=feature/#123', '-f', 'title=New', '-f', 'body=Description', '-F', 'draft=true']);
  });

  it('finds an existing PR and blocks duplicate creation', async () => {
    const run = vi.fn<RunCommand>(async (_command, args) => args[1].includes('/branches?') ? JSON.stringify(branches) : args[1].includes('/pulls?') ? JSON.stringify([{ number: 22, title: 'Existing PR' }]) : JSON.stringify([{ ahead_by: 1, commits: [], files: [] }]));
    const service = createCompareService(run);
    await expect(service.compare('dev', 'feature/#123')).resolves.toMatchObject({ existingPr: { number: 22, title: 'Existing PR' } });
    await expect(service.createPr({ base: 'dev', head: 'feature/#123', title: 'New', body: '', draft: false, expectedBaseSha: base, expectedHeadSha: head })).rejects.toMatchObject({ status: 409 });
    expect(run).not.toHaveBeenCalledWith('gh', expect.arrayContaining(['POST']));
  });
});
