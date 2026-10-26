import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseDiff } from './diff.js';

const execFileAsync = promisify(execFile);
export type RunCommand = (command: 'gh', args: string[]) => Promise<string>;

export class ServiceError extends Error {
  constructor(message: string, public status = 500) { super(message); }
}

export const repository = 'PaulSklarXfit/psxfit365-monorepo';
export const mergeMethods = ['merge', 'squash', 'rebase'] as const;
export type MergeMethod = typeof mergeMethods[number];
export type Mergeability = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';

export function createRunner(): RunCommand {
  return async (command, args) => {
    try {
      const commandArgs = args[0] === 'api'
        ? args.map((arg) => arg.replaceAll('repos/{owner}/{repo}', `repos/${repository}`))
        : [...args, '-R', repository];
      const { stdout } = await execFileAsync(command, commandArgs, {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        timeout: 30_000,
        env: { ...process.env, GH_PROMPT_DISABLED: '1' },
      });
      return stdout;
    } catch (error) {
      const failure = error as Error & { stderr?: string };
      const detail = (failure.stderr || failure.message).trim();
      if (/authentication|not logged in|authorization|bad credentials|permission denied/i.test(detail)) {
        throw new ServiceError('gh chưa được xác thực hoặc không có quyền truy cập.', 502);
      }
      if (/timed out|network|could not resolve|failed to connect|unable to access/i.test(detail)) {
        throw new ServiceError('Không thể kết nối GitHub. Kiểm tra mạng rồi thử lại.', 502);
      }
      throw new ServiceError('gh thất bại. Kiểm tra terminal để biết chi tiết.', 502);
    }
  };
}

export type PrListItem = {
  number: number; title: string; state: string; isDraft: boolean;
  headRefName: string; baseRefName: string; updatedAt: string; url: string;
  reviewDecision: string | null; checkStatus: 'success' | 'failure' | 'pending' | 'none';
  mergeable: Mergeability;
};
export type PrListState = 'open' | 'merged' | 'closed' | 'all';

export type PrComment = {
  kind: 'conversation' | 'review' | 'inline'; author: string; body: string;
  createdAt: string; url: string; path?: string; line?: number | null;
};

const listFields = 'number,title,state,isDraft,headRefName,baseRefName,updatedAt,url,reviewDecision,statusCheckRollup,mergeable';
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
  const mergeable = raw.mergeable === 'MERGEABLE' || raw.mergeable === 'CONFLICTING' ? raw.mergeable : 'UNKNOWN';
  return {
    number: Number(raw.number), title: String(raw.title ?? ''), state: String(raw.state ?? ''),
    isDraft: Boolean(raw.isDraft), headRefName: String(raw.headRefName ?? ''),
    baseRefName: String(raw.baseRefName ?? ''), updatedAt: String(raw.updatedAt ?? ''),
    url: String(raw.url ?? ''), reviewDecision: raw.reviewDecision ? String(raw.reviewDecision) : null,
    checkStatus: checkStatus(checks), mergeable,
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

  async function mergeOptions() {
    const settings = JSON.parse(await run('gh', ['api', 'repos/{owner}/{repo}'])) as Record<string, unknown>;
    return { methods: mergeMethods.filter((method) => {
      if (method === 'merge') return settings.allow_merge_commit === true;
      if (method === 'squash') return settings.allow_squash_merge === true;
      return settings.allow_rebase_merge === true;
    }) };
  }

  async function mergePr(number: number, expectedHeadSha: string, method: MergeMethod) {
    const raw = JSON.parse(await run('gh', ['pr', 'view', String(number), '--json', 'state,isDraft,headRefOid,mergeable'])) as Record<string, unknown>;
    if (raw.state !== 'OPEN' || raw.isDraft === true) throw new ServiceError('PR không còn sẵn sàng để merge. Tải lại trang.', 409);
    if (raw.headRefOid !== expectedHeadSha) throw new ServiceError('Commit của PR đã thay đổi. Tải lại diff trước khi merge.', 409);
    if (raw.mergeable === 'CONFLICTING') throw new ServiceError('PR có merge conflict. Hãy giải quyết conflict trên GitHub trước.', 409);
    const { methods } = await mergeOptions();
    if (!methods.includes(method)) throw new ServiceError('Cách merge này không được bật cho repository.', 409);
    const result = JSON.parse(await run('gh', ['api', '-X', 'PUT', `repos/{owner}/{repo}/pulls/${number}/merge`, '-f', `sha=${expectedHeadSha}`, '-f', `merge_method=${method}`])) as { merged?: boolean };
    if (!result.merged) throw new ServiceError('GitHub chưa merge PR. Tải lại trạng thái rồi thử lại.', 409);
    return { number };
  }

  return { listPrs, prDetail, prFiles, prCommits, mergeOptions, mergePr };
}

export type GitService = ReturnType<typeof createGitService>;
