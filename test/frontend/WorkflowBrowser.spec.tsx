// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import WorkflowBrowser from '../../src/WorkflowBrowser';

const workflows = [{ id: 12, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' }, { id: 13, name: 'Deploy', path: '.github/workflows/deploy.yml', state: 'disabled_manually' }];
const run = { id: 100, workflowId: 12, name: 'CI', title: 'Fix bug', status: 'completed', conclusion: 'success', branch: 'dev', event: 'push', createdAt: '2026-11-02T10:00:00Z', runNumber: 4, actor: 'alice', url: 'https://github.com/PaulSklarXfit/psxfit365-monorepo/actions/runs/100' };

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('shows workflow runs, filters by workflow and paginates', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === '/api/actions/workflows') return { ok: true, json: async () => ({ workflows }) };
    const query = new URL(path, 'http://localhost').searchParams;
    return { ok: true, json: async () => ({ totalCount: 45, runs: [{ ...run, title: query.get('page') === '2' ? 'Older run' : 'Fix bug' }] }) };
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<WorkflowBrowser />);
  expect(await screen.findByRole('link', { name: 'Fix bug' })).toHaveAttribute('href', run.url);
  expect(screen.getByText('Success')).toBeTruthy();
  expect(screen.getByText('45 runs')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  expect(await screen.findByRole('link', { name: 'Older run' })).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledWith('/api/actions/runs?page=2');
  fireEvent.click(screen.getByRole('button', { name: 'CI' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/actions/runs?page=1&workflow=12'));
  expect(screen.getByRole('button', { name: 'CI' })).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(screen.getByRole('button', { name: 'All workflows' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'All workflows' })).toHaveAttribute('aria-pressed', 'true'));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(fetchMock.mock.calls.filter(([path]) => path === '/api/actions/workflows').length).toBe(2));
});

it('shows running and failed statuses without linking to untrusted URLs', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => ({ ok: true, json: async () => String(input).includes('workflows') ? { workflows: [] } : { totalCount: 3, runs: [
    { ...run, status: 'in_progress', conclusion: null, url: 'https://evil.example/run', title: 'Running' },
    { ...run, id: 101, status: 'completed', conclusion: 'failure', title: 'Failed' },
    { ...run, id: 102, status: 'completed', conclusion: 'cancelled', title: 'Cancelled', createdAt: 'bad' },
  ] } })));
  render(<WorkflowBrowser />);
  expect(await screen.findByText('in progress')).toBeTruthy();
  expect(screen.getByText('failure')).toBeTruthy();
  expect(screen.getByText('cancelled')).toBeTruthy();
  expect(screen.getByText('Unknown date')).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'Running' })).toBeNull();
  expect(screen.getByText('No workflows found.')).toBeTruthy();
});

it('shows GitHub errors and lets the user retry', async () => {
  let failed = true;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (failed) return { ok: false, json: async () => ({ error: 'GitHub unavailable' }) };
    return { ok: true, json: async () => String(input).includes('workflows') ? { workflows: [] } : { totalCount: 0, runs: [] } };
  }));
  render(<WorkflowBrowser />);
  expect(await screen.findAllByRole('alert')).toHaveLength(2);
  failed = false;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(await screen.findByText('No workflow runs found.')).toBeTruthy();
});
