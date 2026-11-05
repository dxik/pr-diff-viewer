// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import CompareBrowser from '../../src/CompareBrowser';

const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const branches = [{ name: 'dev', sha: baseSha }, { name: 'feature/#123', sha: headSha }];
const comparison = { base: branches[0], head: branches[1], aheadBy: 1, behindBy: 0, totalCommits: 1, filesLimited: false, commits: [{ sha: headSha, subject: 'Fix issue', author: 'Alice', authoredAt: '2026-01-01' }], files: [{ path: 'src/a.ts', status: 'modified', additions: 1, deletions: 1, patchAvailable: true, hunks: [{ header: '@@ -1 +1 @@', lines: [{ kind: 'remove', oldNumber: 1, newNumber: null, content: 'old' }, { kind: 'add', oldNumber: null, newNumber: 1, content: 'new' }] }] }] };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('compares branches and creates a draft PR only after confirmation', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === '/api/compare/branches') return { ok: true, json: async () => ({ branches }) };
    if (path.startsWith('/api/compare?')) return { ok: true, json: async () => comparison };
    if (path === '/api/session') return { ok: true, json: async () => ({ csrfToken: 'token' }) };
    if (path === '/api/compare/pr' && init?.method === 'POST') return { ok: true, json: async () => ({ number: 144 }) };
    throw new Error(`Unexpected ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const onCreated = vi.fn();
  render(<CompareBrowser onCancel={vi.fn()} onCreated={onCreated} />);
  expect(await screen.findByText('Choose different branches to compare changes.')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Compare branch'), { target: { value: 'feature/#123' } });
  expect(await screen.findByText('Fix issue')).toBeTruthy();
  expect(screen.getByText('new')).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledWith('/api/compare?base=dev&head=feature%2F%23123', undefined);
  fireEvent.click(screen.getByRole('button', { name: 'Create pull request' }));
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: ' New PR ' } });
  fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Body' } });
  fireEvent.click(screen.getByLabelText('Create as draft'));
  expect(fetchMock).not.toHaveBeenCalledWith('/api/compare/pr', expect.anything());
  fireEvent.click(screen.getByRole('button', { name: 'Confirm create pull request' }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith(144));
  expect(fetchMock).toHaveBeenCalledWith('/api/compare/pr', expect.objectContaining({ method: 'POST', body: JSON.stringify({ base: 'dev', head: 'feature/#123', title: 'New PR', body: 'Body', draft: true, expectedBaseSha: baseSha, expectedHeadSha: headSha }) }));
});

it('does not offer creation when there are no commits ahead', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => ({ ok: true, json: async () => String(input).includes('/branches') ? { branches } : { ...comparison, aheadBy: 0, commits: [], files: [], totalCommits: 0 } })));
  render(<CompareBrowser onCancel={vi.fn()} onCreated={vi.fn()} />);
  await screen.findByLabelText('Compare branch');
  fireEvent.change(screen.getByLabelText('Compare branch'), { target: { value: 'feature/#123' } });
  expect(await screen.findByText('No commits to merge')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Create pull request' })).toBeDisabled();
});

it('shows the existing PR and prevents duplicate creation', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => ({ ok: true, json: async () => String(input).includes('/branches') ? { branches } : { ...comparison, existingPr: { number: 22, title: 'Existing PR' } } })));
  render(<CompareBrowser onCancel={vi.fn()} onCreated={vi.fn()} />);
  await screen.findByLabelText('Compare branch');
  fireEvent.change(screen.getByLabelText('Compare branch'), { target: { value: 'feature/#123' } });
  expect(await screen.findByRole('link', { name: '#22 Existing PR' })).toHaveAttribute('href', 'https://github.com/PaulSklarXfit/psxfit365-monorepo/pull/22');
  expect(screen.getByRole('button', { name: 'Create pull request' })).toBeDisabled();
  expect(screen.getByText('new')).toBeTruthy();
});

it('shows a branch-change error and allows refreshing the comparison', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === '/api/compare/branches') return { ok: true, json: async () => ({ branches }) };
    if (path.startsWith('/api/compare?')) return { ok: true, json: async () => comparison };
    if (path === '/api/session') return { ok: true, json: async () => ({ csrfToken: 'token' }) };
    return { ok: false, json: async () => ({ error: 'Branches changed' }) };
  }));
  render(<CompareBrowser onCancel={vi.fn()} onCreated={vi.fn()} />);
  await screen.findByLabelText('Compare branch');
  fireEvent.change(screen.getByLabelText('Compare branch'), { target: { value: 'feature/#123' } });
  fireEvent.click(await screen.findByRole('button', { name: 'Create pull request' }));
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'New PR' } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm create pull request' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Branches changed');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh comparison' }));
  expect(await screen.findByText('Fix issue')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Confirm create pull request' })).toBeNull();
});
