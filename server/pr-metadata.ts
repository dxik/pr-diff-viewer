import { type RunCommand, ServiceError } from './git-service.js';

export const metadataFields = ['reviewers', 'assignees', 'labels', 'projects', 'milestone', 'draft'] as const;
export type MetadataField = typeof metadataFields[number];
export type MetadataAction = 'add' | 'remove' | 'set';

function parseObject(output: string): Record<string, unknown> {
  return JSON.parse(output) as Record<string, unknown>;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value as Record<string, unknown>[] : [];
}

export function createPrMetadataService(run: RunCommand) {
  async function projectList() {
    const raw = parseObject(await run('gh', ['project', 'list', '--owner', 'PaulSklarXfit', '--limit', '1000', '--format', 'json']));
    return records(raw.projects).filter((entry) => entry.closed !== true);
  }

  async function updateProject(number: number, action: MetadataAction, title: string) {
    const query = 'query($number:Int!){repository(owner:"PaulSklarXfit",name:"psxfit365-monorepo"){pullRequest(number:$number){id projectItems(first:100){nodes{id project{id title}}}}}}';
    const raw = parseObject(await run('gh', ['api', 'graphql', '-f', `query=${query}`, '-F', `number=${number}`]));
    const data = raw.data as { repository?: { pullRequest?: { id?: string; projectItems?: { nodes?: { id: string; project: { id: string; title: string } }[] } } } } | undefined;
    const pullRequest = data?.repository?.pullRequest;
    if (!pullRequest?.id) throw new ServiceError('Không đọc được thông tin project của PR.', 502);
    if (action === 'add') {
      const matches = (await projectList()).filter((project) => project.title === title && typeof project.id === 'string');
      if (matches.length !== 1) throw new ServiceError('Không tìm thấy project duy nhất. Tải lại danh sách.', 409);
      const mutation = 'mutation($projectId:ID!,$contentId:ID!){addProjectV2ItemById(input:{projectId:$projectId,contentId:$contentId}){item{id}}}';
      await run('gh', ['api', 'graphql', '-f', `query=${mutation}`, '-f', `projectId=${matches[0].id}`, '-f', `contentId=${pullRequest.id}`]);
    } else {
      const matches = (pullRequest.projectItems?.nodes ?? []).filter((item) => item.project.title === title);
      if (matches.length !== 1) throw new ServiceError('Không tìm thấy project duy nhất trên PR. Tải lại trang.', 409);
      const mutation = 'mutation($projectId:ID!,$itemId:ID!){deleteProjectV2Item(input:{projectId:$projectId,itemId:$itemId}){deletedItemId}}';
      await run('gh', ['api', 'graphql', '-f', `query=${mutation}`, '-f', `projectId=${matches[0].project.id}`, '-f', `itemId=${matches[0].id}`]);
    }
  }

  async function metadata(number: number) {
    const raw = parseObject(await run('gh', ['pr', 'view', String(number), '--json', 'reviewRequests,latestReviews,assignees,labels,milestone,isDraft']));
    const requested = records(raw.reviewRequests).map((entry) => ({
      name: String(entry.login ?? entry.name ?? ''), status: 'REVIEW_REQUESTED', requested: true,
    })).filter((entry) => entry.name);
    const reviewed = records(raw.latestReviews).map((entry) => ({
      name: String((entry.author as Record<string, unknown> | undefined)?.login ?? ''),
      status: String(entry.state ?? ''), requested: false,
    })).filter((entry) => entry.name && !requested.some((request) => request.name === entry.name));
    const milestone = raw.milestone as Record<string, unknown> | null;
    return {
      reviewers: [...requested, ...reviewed],
      assignees: records(raw.assignees).map((entry) => String(entry.login ?? '')).filter(Boolean),
      labels: records(raw.labels).map((entry) => String(entry.name ?? '')).filter(Boolean),
      milestone: milestone ? String(milestone.title ?? '') : null,
      isDraft: raw.isDraft === true,
    };
  }

  async function projects(number: number) {
    const raw = parseObject(await run('gh', ['pr', 'view', String(number), '--json', 'projectItems']));
    return { projects: records(raw.projectItems).map((entry) => String(entry.title ?? '')).filter(Boolean) };
  }

  async function options(field: Exclude<MetadataField, 'draft'>) {
    if (field === 'projects') {
      return { options: (await projectList()).map((entry) => String(entry.title ?? '')).filter(Boolean) };
    }
    const endpoint = field === 'reviewers' || field === 'assignees' ? 'assignees' : field === 'labels' ? 'labels' : 'milestones';
    const output = await run('gh', ['api', `repos/{owner}/{repo}/${endpoint}?per_page=100${field === 'milestone' ? '&state=open' : ''}`, '--paginate', '--slurp']);
    const pages = JSON.parse(output) as Record<string, unknown>[][];
    const values = pages.flat().map((entry) => String(field === 'reviewers' || field === 'assignees' ? entry.login ?? '' : field === 'labels' ? entry.name ?? '' : entry.title ?? '')).filter(Boolean);
    return { options: values };
  }

  async function update(number: number, field: MetadataField, action: MetadataAction, value: string) {
    if (field === 'draft') {
      await run('gh', ['pr', 'ready', String(number), ...(action === 'add' ? ['--undo'] : [])]);
    } else if (field === 'milestone') {
      await run('gh', ['pr', 'edit', String(number), action === 'remove' ? '--remove-milestone' : `--milestone=${value}`]);
    } else if (field === 'projects') {
      await updateProject(number, action, value);
    } else if (field === 'labels') {
      const path = `repos/{owner}/{repo}/issues/${number}/labels`;
      await run('gh', action === 'add' ? ['api', '-X', 'POST', path, '-f', `labels[]=${value}`] : ['api', '-X', 'DELETE', `${path}/${encodeURIComponent(value)}`]);
    } else if (field === 'assignees' && value === '@me' && action === 'add') {
      await run('gh', ['pr', 'edit', String(number), '--add-assignee=@me']);
    } else {
      const isReviewer = field === 'reviewers';
      const path = isReviewer ? `repos/{owner}/{repo}/pulls/${number}/requested_reviewers` : `repos/{owner}/{repo}/issues/${number}/assignees`;
      await run('gh', ['api', '-X', action === 'add' ? 'POST' : 'DELETE', path, '-f', `${isReviewer ? 'reviewers' : 'assignees'}[]=${value}`]);
    }
    return { ok: true };
  }

  return { metadata, projects, options, update };
}
