import { describe, expect, it, vi } from 'vitest';
import { createActionsService } from '../../server/actions-service.js';
import type { RunCommand } from '../../server/git-service.js';

describe('GitHub Actions service', () => {
  it('loads all workflow pages from the fixed repository', async () => {
    const run = vi.fn<RunCommand>(async () => JSON.stringify([
      { workflows: [{ id: 12, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' }] },
      { workflows: [{ id: 13, name: 'Deploy', path: '.github/workflows/deploy.yml', state: 'disabled_manually' }] },
    ]));
    await expect(createActionsService(run).workflows()).resolves.toEqual({ workflows: [
      { id: 12, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' },
      { id: 13, name: 'Deploy', path: '.github/workflows/deploy.yml', state: 'disabled_manually' },
    ] });
    expect(run).toHaveBeenCalledWith('gh', ['api', 'repos/{owner}/{repo}/actions/workflows?per_page=100', '--paginate', '--slurp']);
  });

  it('loads paginated runs for all workflows or a selected workflow', async () => {
    const run = vi.fn<RunCommand>(async () => JSON.stringify({ total_count: 42, workflow_runs: [
      { id: 8, workflow_id: 12, name: 'CI', display_title: 'Fix bug', status: 'completed', conclusion: 'success', head_branch: 'dev', event: 'push', created_at: '2026-11-02T10:00:00Z', run_number: 4, html_url: 'https://github.com/example', actor: { login: 'alice' } },
      { id: 9 },
    ] }));
    const service = createActionsService(run);
    await expect(service.runs(null, 1)).resolves.toEqual({ totalCount: 42, runs: [
      { id: 8, workflowId: 12, name: 'CI', title: 'Fix bug', status: 'completed', conclusion: 'success', branch: 'dev', event: 'push', createdAt: '2026-11-02T10:00:00Z', runNumber: 4, url: 'https://github.com/example', actor: 'alice' },
      { id: 9, workflowId: 0, name: '', title: '', status: '', conclusion: null, branch: '', event: '', createdAt: '', runNumber: 0, url: '', actor: 'Unknown' },
    ] });
    await service.runs(12, 2);
    expect(run).toHaveBeenCalledWith('gh', ['api', 'repos/{owner}/{repo}/actions/runs?per_page=30&page=1']);
    expect(run).toHaveBeenCalledWith('gh', ['api', 'repos/{owner}/{repo}/actions/workflows/12/runs?per_page=30&page=2']);
  });
});
