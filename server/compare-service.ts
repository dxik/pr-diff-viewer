import { type RunCommand, ServiceError } from './git-service.js';
import { parseDiff } from './diff.js';

type Branch = { name: string; sha: string };
type CreateInput = { base: string; head: string; title: string; body: string; draft: boolean; expectedBaseSha: string; expectedHeadSha: string };

export function createCompareService(run: RunCommand) {
  async function branches() {
    const pages = JSON.parse(await run('gh', ['api', 'repos/{owner}/{repo}/branches?per_page=100', '--paginate', '--slurp'])) as { name: string; commit: { sha: string } }[][];
    return { branches: pages.flat().map((branch) => ({ name: branch.name, sha: branch.commit.sha })) };
  }

  async function resolveBranches(base: string, head: string): Promise<{ base: Branch; head: Branch }> {
    if (base === head) throw new ServiceError('Hãy chọn hai nhánh khác nhau.', 400);
    const available = (await branches()).branches;
    const baseBranch = available.find((branch) => branch.name === base);
    const headBranch = available.find((branch) => branch.name === head);
    if (!baseBranch || !headBranch) throw new ServiceError('Không tìm thấy nhánh trên GitHub. Hãy tải lại danh sách.', 400);
    return { base: baseBranch, head: headBranch };
  }

  async function existingPr(base: string, head: string) {
    const query = new URLSearchParams({ state: 'open', base, head: `PaulSklarXfit:${head}`, per_page: '1' });
    const pulls = JSON.parse(await run('gh', ['api', `repos/{owner}/{repo}/pulls?${query}`])) as { number: number; title: string }[];
    const pr = pulls[0];
    return pr && Number.isSafeInteger(pr.number) && pr.number > 0 ? { number: pr.number, title: String(pr.title ?? '') } : null;
  }

  async function compare(base: string, head: string) {
    const selected = await resolveBranches(base, head);
    const [compareOutput, existing] = await Promise.all([
      run('gh', ['api', `repos/{owner}/{repo}/compare/${selected.base.sha}...${selected.head.sha}?per_page=100`, '--paginate', '--slurp']),
      existingPr(base, head),
    ]);
    const pages = JSON.parse(compareOutput) as Record<string, unknown>[];
    const first = pages[0];
    const entries = Array.isArray(first.files) ? first.files as Record<string, unknown>[] : [];
    const commits = pages.flatMap((page) => Array.isArray(page.commits) ? page.commits as Record<string, unknown>[] : []);
    return {
      base: selected.base, head: selected.head, existingPr: existing,
      aheadBy: Number(first.ahead_by ?? 0), behindBy: Number(first.behind_by ?? 0),
      totalCommits: Number(first.total_commits ?? commits.length), filesLimited: entries.length >= 300,
      commits: commits.map((entry) => {
        const commit = entry.commit as Record<string, unknown> | undefined;
        const author = commit?.author as Record<string, unknown> | undefined;
        return { sha: String(entry.sha ?? ''), subject: String(commit?.message ?? '').split('\n')[0], author: String(author?.name ?? 'Unknown'), authoredAt: String(author?.date ?? '') };
      }),
      files: entries.map((entry) => {
        const path = String(entry.filename ?? '');
        const patchAvailable = typeof entry.patch === 'string';
        const parsed = patchAvailable ? parseDiff(entry.patch as string, path) : { hunks: [], isBinary: false };
        return { path, ...(typeof entry.previous_filename === 'string' ? { oldPath: entry.previous_filename } : {}), status: String(entry.status ?? 'modified'), additions: Number(entry.additions ?? 0), deletions: Number(entry.deletions ?? 0), patchAvailable, hunks: parsed.hunks };
      }),
    };
  }

  async function createPr(input: CreateInput) {
    const selected = await resolveBranches(input.base, input.head);
    if (selected.base.sha !== input.expectedBaseSha || selected.head.sha !== input.expectedHeadSha) throw new ServiceError('Nhánh đã thay đổi. Hãy compare lại trước khi tạo PR.', 409);
    if (await existingPr(input.base, input.head)) throw new ServiceError('Hai nhánh này đã có PR đang mở. Hãy tải lại phần compare.', 409);
    const result = JSON.parse(await run('gh', ['api', '-X', 'POST', 'repos/{owner}/{repo}/pulls', '-f', `base=${input.base}`, '-f', `head=${input.head}`, '-f', `title=${input.title}`, '-f', `body=${input.body}`, '-F', `draft=${input.draft}`])) as { number?: number; html_url?: string };
    if (!Number.isSafeInteger(result.number) || !result.number) throw new ServiceError('PR đã được gửi nhưng không đọc được kết quả từ GitHub.', 502);
    return { number: result.number, url: result.html_url ?? '' };
  }

  return { branches, compare, createPr };
}
