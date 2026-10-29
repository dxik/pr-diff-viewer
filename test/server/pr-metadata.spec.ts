import { describe, expect, it, vi } from 'vitest';
import { createPrMetadataService } from '../../server/pr-metadata.js';
import type { RunCommand } from '../../server/git-service.js';

describe('PR metadata', () => {
  it('creates a label in the fixed repository with the requested color', async () => {
    const run = vi.fn<RunCommand>(async () => JSON.stringify({ name: 'dev-dungtran' }));
    await expect(createPrMetadataService(run).createLabel('dev-dungtran', '5b8def')).resolves.toEqual({ name: 'dev-dungtran' });
    expect(run).toHaveBeenCalledWith('gh', ['api', '-X', 'POST', 'repos/{owner}/{repo}/labels', '-f', 'name=dev-dungtran', '-f', 'color=5b8def']);
  });
  it('reads reviewers, assignees, labels, milestone, draft and project data', async () => {
    const run = vi.fn<RunCommand>(async (_command, args) => args.includes('projectItems')
      ? JSON.stringify({ projectItems: [{ title: 'Roadmap' }] })
      : JSON.stringify({ reviewRequests: [{ login: 'alice' }], latestReviews: [{ author: { login: 'alice' }, state: 'APPROVED' }, { author: { login: 'bob' }, state: 'CHANGES_REQUESTED' }], assignees: [{ login: 'carol' }], labels: [{ name: 'bug' }], milestone: { title: 'v1' }, isDraft: true }));
    const service = createPrMetadataService(run);
    await expect(service.metadata(42)).resolves.toEqual({ reviewers: [{ name: 'alice', status: 'REVIEW_REQUESTED', requested: true }, { name: 'bob', status: 'CHANGES_REQUESTED', requested: false }], assignees: ['carol'], labels: ['bug'], milestone: 'v1', isDraft: true });
    await expect(service.projects(42)).resolves.toEqual({ projects: ['Roadmap'] });
  });

  it('loads available choices across GitHub pages', async () => {
    const run = vi.fn<RunCommand>(async (_command, args) => {
      if (args[0] === 'project') return JSON.stringify({ projects: [{ title: 'Roadmap' }] });
      if (args[1].includes('/assignees')) return JSON.stringify([[{ login: 'alice' }], [{ login: 'bob' }]]);
      if (args[1].includes('/labels')) return JSON.stringify([[{ name: 'bug' }]]);
      return JSON.stringify([[{ title: 'v1' }]]);
    });
    const service = createPrMetadataService(run);
    await expect(service.options('reviewers')).resolves.toEqual({ options: ['alice', 'bob'] });
    await expect(service.options('assignees')).resolves.toEqual({ options: ['alice', 'bob'] });
    await expect(service.options('labels')).resolves.toEqual({ options: ['bug'] });
    await expect(service.options('milestone')).resolves.toEqual({ options: ['v1'] });
    await expect(service.options('projects')).resolves.toEqual({ options: ['Roadmap'] });
  });

  it('uses the requested GitHub action for each setting', async () => {
    const run = vi.fn<RunCommand>(async (_command, args) => {
      if (args[0] === 'project') return JSON.stringify({ projects: [{ id: 'project-id', title: 'Roadmap, 2026' }] });
      if (args[1] === 'graphql' && args.some((arg) => arg.startsWith('query=query'))) return JSON.stringify({ data: { repository: { pullRequest: { id: 'pr-id', projectItems: { nodes: [{ id: 'item-id', project: { id: 'project-id', title: 'Roadmap, 2026' } }] } } } } });
      return '{}';
    });
    const service = createPrMetadataService(run);
    await service.update(42, 'reviewers', 'add', 'alice');
    await service.update(42, 'assignees', 'remove', 'bob');
    await service.update(42, 'assignees', 'add', '@me');
    await service.update(42, 'labels', 'add', 'bug');
    await service.update(42, 'labels', 'remove', 'bug/urgent');
    await service.update(42, 'projects', 'add', 'Roadmap, 2026');
    await service.update(42, 'projects', 'remove', 'Roadmap, 2026');
    await service.update(42, 'milestone', 'set', 'v1');
    await service.update(42, 'milestone', 'remove', '');
    await service.update(42, 'draft', 'add', '');
    await service.update(42, 'draft', 'remove', '');
    expect(run).toHaveBeenCalledWith('gh', ['api', '-X', 'POST', 'repos/{owner}/{repo}/pulls/42/requested_reviewers', '-f', 'reviewers[]=alice']);
    expect(run).toHaveBeenCalledWith('gh', ['api', '-X', 'DELETE', 'repos/{owner}/{repo}/issues/42/assignees', '-f', 'assignees[]=bob']);
    expect(run).toHaveBeenCalledWith('gh', ['pr', 'edit', '42', '--add-assignee=@me']);
    expect(run).toHaveBeenCalledWith('gh', ['api', '-X', 'POST', 'repos/{owner}/{repo}/issues/42/labels', '-f', 'labels[]=bug']);
    expect(run).toHaveBeenCalledWith('gh', ['api', '-X', 'DELETE', 'repos/{owner}/{repo}/issues/42/labels/bug%2Furgent']);
    expect(run).toHaveBeenCalledWith('gh', expect.arrayContaining(['api', 'graphql', 'projectId=project-id', 'contentId=pr-id']));
    expect(run).toHaveBeenCalledWith('gh', expect.arrayContaining(['api', 'graphql', 'projectId=project-id', 'itemId=item-id']));
    expect(run).toHaveBeenCalledWith('gh', ['pr', 'edit', '42', '--milestone=v1']);
    expect(run).toHaveBeenCalledWith('gh', ['pr', 'edit', '42', '--remove-milestone']);
    expect(run).toHaveBeenCalledWith('gh', ['pr', 'ready', '42', '--undo']);
    expect(run).toHaveBeenCalledWith('gh', ['pr', 'ready', '42']);
    await expect(service.update(42, 'projects', 'add', 'missing')).rejects.toMatchObject({ status: 409 });
  });
});
