// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import PrMetadata from '../../src/PrMetadata';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function mockMetadata(projectFailure = false, applyFailure = false) {
  let current = { reviewers: [] as { name: string; status: string; requested: boolean }[], assignees: [] as string[], labels: [] as string[], milestone: null as string | null, isDraft: false };
  let projects: string[] = [];
  let labelOptions = ['bug'];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    let result: unknown;
    if (path === '/api/session') result = { csrfToken: 'csrf' };
    else if (path.endsWith('/metadata/projects')) {
      if (projectFailure) return { ok: false, json: async () => ({ error: 'No project access' }) };
      result = { projects };
    } else if (path.includes('/metadata/options?')) {
      const field = new URL(path, 'http://localhost').searchParams.get('field');
      result = { options: field === 'reviewers' || field === 'assignees' ? ['alice'] : field === 'labels' ? labelOptions : field === 'projects' ? ['Roadmap'] : ['v1'] };
    } else if (path === '/api/labels' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { name: string };
      labelOptions = [...labelOptions, body.name];
      result = { name: body.name };
    } else if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { field: string; action: string; value: string };
      if (applyFailure && body.field === 'labels' && body.value === 'dev-dungtran') return { ok: false, json: async () => ({ error: 'No write access' }) };
      if (body.field === 'reviewers') current = { ...current, reviewers: body.action === 'add' ? [{ name: body.value, status: 'REVIEW_REQUESTED', requested: true }] : [] };
      if (body.field === 'assignees') current = { ...current, assignees: body.action === 'add' ? [body.value === '@me' ? 'me' : body.value] : [] };
      if (body.field === 'labels') current = { ...current, labels: body.action === 'add' ? [body.value] : [] };
      if (body.field === 'projects') projects = body.action === 'add' ? [body.value] : [];
      if (body.field === 'milestone') current = { ...current, milestone: body.action === 'remove' ? null : body.value };
      if (body.field === 'draft') current = { ...current, isDraft: body.action === 'add' };
      result = { ok: true };
    } else result = current;
    return { ok: true, json: async () => result };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

it('edits PR settings and refreshes them after GitHub accepts changes', async () => {
  const fetchMock = mockMetadata();
  const onDraftChange = vi.fn();
  render(<PrMetadata number={42} state="OPEN" onDraftChange={onDraftChange} />);
  await screen.findByText('No reviewers');
  const sidebar = screen.getByRole('complementary', { name: 'Pull request settings' });

  for (const [field, choice] of [['Reviewers', 'alice'], ['Assignees', 'alice'], ['Labels', 'bug'], ['Projects', 'Roadmap'], ['Milestone', 'v1']]) {
    fireEvent.click(within(sidebar).getByRole('button', { name: `Edit ${field}` }));
    const option = await screen.findByLabelText(choice);
    fireEvent.click(option);
    await waitFor(() => expect(option).toBeChecked());
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
  }
  fireEvent.click(screen.getByRole('button', { name: 'Convert to draft' }));
  await waitFor(() => expect(onDraftChange).toHaveBeenCalledWith(true));
  expect(screen.getByRole('button', { name: 'Mark ready for review' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Mark ready for review' }));
  await waitFor(() => expect(onDraftChange).toHaveBeenCalledWith(false));
  fireEvent.click(screen.getByRole('button', { name: 'Assign yourself' }));
  await waitFor(() => expect(within(sidebar).getByText('me')).toBeTruthy());
  expect(fetchMock).toHaveBeenCalledWith('/api/prs/42/metadata', expect.objectContaining({ method: 'POST', body: JSON.stringify({ field: 'projects', action: 'add', value: 'Roadmap' }) }));
  fireEvent.click(screen.getByRole('button', { name: 'Edit Milestone' }));
  await screen.findByText('Clear milestone');
  fireEvent.click(screen.getByText('Clear milestone'));
  await waitFor(() => expect(screen.getByText('No milestone')).toBeTruthy());
});

it('creates a label with the chosen color and applies it to the PR', async () => {
  const fetchMock = mockMetadata();
  render(<PrMetadata number={42} state="OPEN" onDraftChange={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit Labels' }));
  await screen.findByLabelText('bug');
  fireEvent.change(screen.getByLabelText('Search labels'), { target: { value: 'dev-dungtran' } });
  fireEvent.change(screen.getByLabelText('Color'), { target: { value: '#ff8800' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create new label "dev-dungtran"' }));
  await waitFor(() => expect(screen.getByLabelText('dev-dungtran')).toBeChecked());
  expect(fetchMock).toHaveBeenCalledWith('/api/labels', expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'dev-dungtran', color: 'ff8800' }) }));
  expect(fetchMock).toHaveBeenCalledWith('/api/prs/42/metadata', expect.objectContaining({ method: 'POST', body: JSON.stringify({ field: 'labels', action: 'add', value: 'dev-dungtran' }) }));
});

it('reports when a label was created but could not be applied', async () => {
  mockMetadata(false, true);
  render(<PrMetadata number={42} state="OPEN" onDraftChange={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit Labels' }));
  await screen.findByLabelText('bug');
  fireEvent.change(screen.getByLabelText('Search labels'), { target: { value: 'dev-dungtran' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create new label "dev-dungtran"' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Label created, but could not be applied: No write access');
  expect(screen.getByLabelText('dev-dungtran')).not.toBeChecked();
  expect(screen.queryByRole('button', { name: /Create new label/ })).toBeNull();
});

it('keeps other settings available when project access fails', async () => {
  mockMetadata(true);
  render(<PrMetadata number={42} state="OPEN" onDraftChange={vi.fn()} />);
  expect(await screen.findByText('Could not load projects. Check access and run gh auth refresh -s project if needed.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Edit Projects' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Edit Labels' })).toBeEnabled();
});
