import type { RunCommand } from './git-service.js';

export function createActionsService(run: RunCommand) {
  async function workflows() {
    const pages = JSON.parse(await run('gh', ['api', 'repos/{owner}/{repo}/actions/workflows?per_page=100', '--paginate', '--slurp'])) as { workflows: Record<string, unknown>[] }[];
    return { workflows: pages.flatMap((page) => page.workflows.map((workflow) => ({
      id: Number(workflow.id), name: String(workflow.name ?? ''),
      path: String(workflow.path ?? ''), state: String(workflow.state ?? ''),
    }))) };
  }

  async function runs(workflowId: number | null, page: number) {
    const path = workflowId === null ? 'actions/runs' : `actions/workflows/${workflowId}/runs`;
    const result = JSON.parse(await run('gh', ['api', `repos/{owner}/{repo}/${path}?per_page=30&page=${page}`])) as { total_count: number; workflow_runs: Record<string, unknown>[] };
    return {
      totalCount: result.total_count,
      runs: result.workflow_runs.map((entry) => ({
        id: Number(entry.id), workflowId: Number(entry.workflow_id ?? 0), name: String(entry.name ?? ''),
        title: String(entry.display_title ?? ''), status: String(entry.status ?? ''),
        conclusion: entry.conclusion ? String(entry.conclusion) : null, branch: String(entry.head_branch ?? ''),
        event: String(entry.event ?? ''), createdAt: String(entry.created_at ?? ''),
        runNumber: Number(entry.run_number ?? 0), url: String(entry.html_url ?? ''),
        actor: String((entry.actor as Record<string, unknown> | null)?.login ?? 'Unknown'),
      })),
    };
  }

  return { workflows, runs };
}
