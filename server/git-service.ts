import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseDiff } from './diff.js';

const execFileAsync = promisify(execFile);
export type RunCommand = (command: 'git' | 'gh', args: string[]) => Promise<string>;

export class ServiceError extends Error {
  constructor(message: string, public status = 500) { super(message); }
}

export function createRunner(repoRoot: string, repo?: string): RunCommand {
  if (repo && !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repo)) {
    throw new Error('Invalid GitHub repository. Use owner/repo.');
  }
  return async (command, args) => {
    try {
      const commandArgs = command === 'gh' && repo
        ? args[0] === 'api'
          ? args.map((arg) => arg.replaceAll('repos/{owner}/{repo}', `repos/${repo}`))
          : [...args, '-R', repo]
        : args;
      const { stdout } = await execFileAsync(command, commandArgs, {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        timeout: 30_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' },
      });
      return stdout;
    } catch (error) {
      const failure = error as Error & { stderr?: string; code?: string };
      const detail = (failure.stderr || failure.message).trim();
      if (/authentication|not logged in|authorization|bad credentials|permission denied/i.test(detail)) {
        throw new ServiceError(`${command} chưa được xác thực hoặc không có quyền truy cập.`, 502);
      }
      if (/timed out|network|could not resolve|failed to connect|unable to access/i.test(detail)) {
        throw new ServiceError(`Không thể kết nối Git/GitHub. Kiểm tra mạng rồi thử lại.`, 502);
      }
      throw new ServiceError(`${command} thất bại. Kiểm tra terminal để biết chi tiết.`, 502);
    }
  };
}

export type PullRequest = {
  number: number; title: string; body: string; url: string; state: string;
  isDraft: boolean; reviewDecision: string | null;
  checks: { name: string; status: string; conclusion: string | null }[];
};

export type PrListItem = {
  number: number; title: string; state: string; isDraft: boolean;
  headRefName: string; baseRefName: string; updatedAt: string; url: string;
  reviewDecision: string | null; checkStatus: 'success' | 'failure' | 'pending' | 'none';
};
export type PrListState = 'open' | 'merged' | 'closed' | 'all';

export type PrComment = {
  kind: 'conversation' | 'review' | 'inline'; author: string; body: string;
  createdAt: string; url: string; path?: string; line?: number | null;
};

const listFields = 'number,title,state,isDraft,headRefName,baseRefName,updatedAt,url,reviewDecision,statusCheckRollup';
const detailFields = `${listFields},body,comments,reviews,headRefOid`;

function checkStatus(checks: Record<string, unknown>[]): PrListItem['checkStatus'] {
  if (checks.length === 0) return 'none';
  if (checks.some((check) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'CANCELLED'].includes(String(check.conclusion ?? check.state ?? '').toUpperCase()))) return 'failure';
  if (checks.some((check) => {
    const result = String(check.conclusion ?? check.state ?? '').toUpperCase();
    return !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(result);
  })) return 'pending';
  return 'success';
}

function normalizePr(raw: Record<string, unknown>): PrListItem {
  const checks = Array.isArray(raw.statusCheckRollup) ? raw.statusCheckRollup as Record<string, unknown>[] : [];
  return {
    number: Number(raw.number), title: String(raw.title ?? ''), state: String(raw.state ?? ''),
    isDraft: Boolean(raw.isDraft), headRefName: String(raw.headRefName ?? ''),
    baseRefName: String(raw.baseRefName ?? ''), updatedAt: String(raw.updatedAt ?? ''),
    url: String(raw.url ?? ''), reviewDecision: raw.reviewDecision ? String(raw.reviewDecision) : null,
    checkStatus: checkStatus(checks),
  };
}

function commentAuthor(raw: Record<string, unknown>): string {
  const author = raw.author ?? raw.user;
  if (!author || typeof author !== 'object') return 'Unknown';
  return String((author as Record<string, unknown>).login ?? 'Unknown');
}

export function createGitService(run: RunCommand) {
  async function changedFiles(number: number) {
    const pages = JSON.parse(await run('gh', ['api', `repos/{owner}/{repo}/pulls/${number}/files?per_page=100`, '--paginate', '--slurp'])) as Record<string, unknown>[][];
    return pages.flat();
  }

  async function prFiles(number: number) {
    const entries = await changedFiles(number);
    return { files: entries.map((entry) => {
      const path = String(entry.filename ?? '');
      const patchAvailable = typeof entry.patch === 'string';
      const parsed = patchAvailable ? parseDiff(entry.patch as string, path) : { hunks: [], isBinary: false };
      return {
        path,
        sha: typeof entry.sha === 'string' ? entry.sha : '',
        ...(typeof entry.previous_filename === 'string' ? { oldPath: entry.previous_filename } : {}),
        status: String(entry.status ?? 'modified'),
        additions: Number(entry.additions ?? 0), deletions: Number(entry.deletions ?? 0),
        patchAvailable, isBinary: parsed.isBinary, hunks: parsed.hunks,
      };
    }) };
  }

  async function prCommits(number: number) {
    const pages = JSON.parse(await run('gh', ['api', `repos/{owner}/{repo}/pulls/${number}/commits?per_page=100`, '--paginate', '--slurp'])) as Record<string, unknown>[][];
    return { commits: pages.flat().map((entry) => {
      const commit = entry.commit as Record<string, unknown> | undefined;
      const author = commit?.author as Record<string, unknown> | undefined;
      return {
        sha: String(entry.sha ?? ''), subject: String(commit?.message ?? '').split('\n')[0],
        author: String(author?.name ?? 'Unknown'), authoredAt: String(author?.date ?? ''),
      };
    }) };
  }

  async function listPrs(state: PrListState) {
    const raw = JSON.parse(await run('gh', ['pr', 'list', '--state', state, '--search', 'sort:updated-desc', '--limit', '100', '--json', listFields])) as Record<string, unknown>[];
    return { items: raw.map(normalizePr) };
  }

  async function listBranches() {
    const pages = JSON.parse(await run('gh', ['api', 'repos/{owner}/{repo}/branches?per_page=100', '--paginate', '--slurp'])) as unknown;
    if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new ServiceError('Không đọc được danh sách nhánh từ GitHub.', 502);
    return { branches: pages.flat().map((entry: unknown) => {
      const branch = entry as { name?: unknown; commit?: { sha?: unknown } };
      if (typeof branch?.name !== 'string' || typeof branch.commit?.sha !== 'string') {
        throw new ServiceError('Không đọc được danh sách nhánh từ GitHub.', 502);
      }
      return { name: branch.name, sha: branch.commit.sha };
    }) };
  }

  async function prDetail(number: number) {
    const [viewOutput, inlineOutput] = await Promise.all([
      run('gh', ['pr', 'view', String(number), '--json', detailFields]),
      run('gh', ['api', `repos/{owner}/{repo}/pulls/${number}/comments?per_page=100`, '--paginate', '--slurp']),
    ]);
    const raw = JSON.parse(viewOutput) as Record<string, unknown>;
    const inlinePages = JSON.parse(inlineOutput) as Record<string, unknown>[][];
    const checks = Array.isArray(raw.statusCheckRollup) ? raw.statusCheckRollup as Record<string, unknown>[] : [];
    const conversations = Array.isArray(raw.comments) ? raw.comments as Record<string, unknown>[] : [];
    const reviews = Array.isArray(raw.reviews) ? raw.reviews as Record<string, unknown>[] : [];
    const comments: PrComment[] = [
      ...conversations.map((entry) => ({
        kind: 'conversation' as const, author: commentAuthor(entry), body: String(entry.body ?? ''),
        createdAt: String(entry.createdAt ?? ''), url: String(entry.url ?? ''),
      })),
      ...reviews.filter((entry) => String(entry.body ?? '').trim()).map((entry) => ({
        kind: 'review' as const, author: commentAuthor(entry), body: String(entry.body),
        createdAt: String(entry.submittedAt ?? entry.createdAt ?? ''), url: String(entry.url ?? ''),
      })),
      ...inlinePages.flat().map((entry) => ({
        kind: 'inline' as const, author: commentAuthor(entry), body: String(entry.body ?? ''),
        createdAt: String(entry.created_at ?? ''), url: String(entry.html_url ?? ''),
        path: String(entry.path ?? ''), line: typeof entry.line === 'number' ? entry.line : null,
      })),
    ];
    return {
      pr: {
        ...normalizePr(raw), body: String(raw.body ?? ''), headRefOid: String(raw.headRefOid ?? ''),
        checks: checks.map((check) => ({
          name: String(check.name ?? check.context ?? 'Check'),
          status: String(check.status ?? check.state ?? 'UNKNOWN'),
          conclusion: check.conclusion ? String(check.conclusion) : null,
        })),
      },
      comments: [...comments].sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    };
  }
  async function branchAndHead() {
    const branch = (await run('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim();
    const headSha = (await run('git', ['rev-parse', 'HEAD'])).trim();
    if (!branch || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)) {
      throw new ServiceError('Nhánh hiện tại không hợp lệ hoặc HEAD đang detached.', 409);
    }
    return { branch, headSha };
  }

  async function remoteSha(branch: string) {
    const output = await run('git', ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]);
    return output.trim().split(/\s+/)[0] || null;
  }

  async function findPr(branch: string, base?: string): Promise<PullRequest | null> {
    const args = ['pr', 'list', '--head', branch];
    if (base) args.push('--base', base);
    args.push('--state', 'open', '--limit', '1', '--json', 'number');
    const list = JSON.parse(await run('gh', args)) as { number: number }[];
    if (list.length === 0) return null;
    const raw = JSON.parse(await run('gh', ['pr', 'view', String(list[0].number), '--json', 'number,title,body,url,state,isDraft,reviewDecision,statusCheckRollup'])) as Record<string, unknown>;
    const contexts = Array.isArray(raw.statusCheckRollup) ? raw.statusCheckRollup as Record<string, unknown>[] : [];
    return {
      number: Number(raw.number), title: String(raw.title), body: String(raw.body ?? ''),
      url: String(raw.url), state: String(raw.state), isDraft: Boolean(raw.isDraft),
      reviewDecision: raw.reviewDecision ? String(raw.reviewDecision) : null,
      checks: contexts.map((check) => ({
        name: String(check.name ?? check.context ?? 'Check'),
        status: String(check.status ?? check.state ?? 'UNKNOWN'),
        conclusion: check.conclusion ? String(check.conclusion) : null,
      })),
    };
  }

  async function summary() {
    const { branch, headSha } = await branchAndHead();
    const pr = await findPr(branch);
    return { branch, headSha, pr };
  }

  async function pushStatus() {
    const { branch, headSha } = await branchAndHead();
    const remote = await remoteSha(branch);
    return { needsPush: remote !== headSha, branch, headSha, remoteSha: remote };
  }

  async function verifyExpectedHead(expectedHeadSha: string) {
    const current = await branchAndHead();
    if (expectedHeadSha !== current.headSha) throw new ServiceError('HEAD đã thay đổi. Tải lại trang trước khi tiếp tục.', 409);
    return current;
  }

  async function push(expectedHeadSha: string) {
    const { branch, headSha } = await verifyExpectedHead(expectedHeadSha);
    await run('git', ['push', 'origin', `${headSha}:refs/heads/${branch}`]);
    await run('git', ['branch', `--set-upstream-to=origin/${branch}`, branch]);
    return { branch, headSha, remoteSha: await remoteSha(branch) };
  }

  async function createPr(input: { title: string; body: string; draft: boolean; expectedHeadSha: string }) {
    const { branch, headSha } = await verifyExpectedHead(input.expectedHeadSha);
    if (await findPr(branch)) throw new ServiceError('Nhánh này đã có PR đang mở.', 409);
    if (await remoteSha(branch) !== headSha) throw new ServiceError('Hãy push HEAD hiện tại trước khi tạo PR.', 409);
    const args = ['pr', 'create', '--base', 'dev', '--head', branch, '--title', input.title, '--body', input.body];
    if (input.draft) args.push('--draft');
    await run('gh', args);
    const pr = await findPr(branch);
    if (!pr) throw new ServiceError('PR đã được tạo nhưng chưa đọc được từ GitHub. Hãy tải lại trang.', 502);
    return pr;
  }

  async function createRemotePr(input: { headBranch: string; title: string; body: string; draft: boolean }) {
    const { branches } = await listBranches();
    if (!branches.some((branch) => branch.name === input.headBranch)) throw new ServiceError('Nhánh không tồn tại trên GitHub. Tải lại danh sách nhánh.', 400);
    if (input.headBranch === 'dev') throw new ServiceError('Không thể tạo PR từ dev vào dev.', 400);
    if (await findPr(input.headBranch, 'dev')) throw new ServiceError('Nhánh này đã có PR đang mở vào dev.', 409);
    const args = ['pr', 'create', '--base', 'dev', '--head', input.headBranch, '--title', input.title, '--body', input.body];
    if (input.draft) args.push('--draft');
    await run('gh', args);
    const pr = await findPr(input.headBranch, 'dev');
    if (!pr) throw new ServiceError('PR đã được tạo nhưng chưa đọc được từ GitHub. Hãy tải lại trang.', 502);
    return pr;
  }

  async function mergePr(number: number, expectedHeadSha: string) {
    const raw = JSON.parse(await run('gh', ['pr', 'view', String(number), '--json', 'state,isDraft,headRefOid'])) as Record<string, unknown>;
    if (raw.state !== 'OPEN' || raw.isDraft === true) throw new ServiceError('PR không còn sẵn sàng để merge. Tải lại trang.', 409);
    if (raw.headRefOid !== expectedHeadSha) throw new ServiceError('Commit của PR đã thay đổi. Tải lại diff trước khi merge.', 409);
    const result = JSON.parse(await run('gh', ['api', '-X', 'PUT', `repos/{owner}/{repo}/pulls/${number}/merge`, '-f', `sha=${expectedHeadSha}`, '-f', 'merge_method=merge'])) as { merged?: boolean };
    if (!result.merged) throw new ServiceError('GitHub chưa merge PR. Tải lại trạng thái rồi thử lại.', 409);
    return { number };
  }

  return { summary, pushStatus, listPrs, listBranches, prDetail, prFiles, prCommits, push, createPr, createRemotePr, mergePr };
}

export type GitService = ReturnType<typeof createGitService>;
