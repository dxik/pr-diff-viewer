import { afterEach, describe, expect, it, vi } from 'vitest';
import { request as httpRequest, type Server } from 'node:http';
import { createServer } from '../../server/http.js';
import type { GitService } from '../../server/git-service.js';

const head = 'a'.repeat(40);
let server: Server | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

function serviceFixture() {
  return {
    summary: vi.fn(async () => ({ branch: 'feature/review', headSha: head, pr: null })),
    pushStatus: vi.fn(async () => ({ needsPush: true, branch: 'feature/review', headSha: head, remoteSha: null })),
    push: vi.fn(async () => ({ branch: 'feature/review', headSha: head, remoteSha: head })),
    createPr: vi.fn(async () => ({ number: 1 })),
    listBranches: vi.fn(async () => ({ branches: [{ name: 'feature/review', sha: head }] })),
    createRemotePr: vi.fn(async () => ({ number: 2 })),
    listPrs: vi.fn(async () => ({ items: [{ number: 143 }] })),
    prDetail: vi.fn(async (number: number) => ({ pr: { number }, comments: [] })),
    prFiles: vi.fn(async (number: number) => ({ files: [{ path: 'src/a.ts', number }] })),
    prCommits: vi.fn(async (number: number) => ({ commits: [{ sha: head, number }] })),
    mergePr: vi.fn(async (number: number) => ({ number })),
  };
}

async function start(service: ReturnType<typeof serviceFixture>) {
  server = createServer({ service: service as unknown as GitService });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}

function call(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port, method, path, headers: { Host: '127.0.0.1:4318', ...headers } }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode!, body: JSON.parse(text) }));
    });
    request.on('error', reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

describe('local HTTP API', () => {
  it('validates merge requests and requires the CSRF token', async () => {
    const service = serviceFixture();
    const port = await start(service);
    const token = (await call(port, 'GET', '/api/session')).body.csrfToken as string;
    const headers = { Origin: 'http://127.0.0.1:4317', 'X-CSRF-Token': token, 'Content-Type': 'application/json' };
    expect((await call(port, 'POST', '/api/prs/143/merge', headers, { expectedHeadSha: head })).body).toEqual({ number: 143 });
    expect(service.mergePr).toHaveBeenCalledWith(143, head);
    expect((await call(port, 'POST', '/api/prs/143/merge', { ...headers, 'X-CSRF-Token': 'wrong' }, { expectedHeadSha: head })).status).toBe(403);
    expect((await call(port, 'POST', '/api/prs/0/merge', headers, { expectedHeadSha: head })).status).toBe(400);
    expect((await call(port, 'POST', '/api/prs/143/merge', headers, { expectedHeadSha: 'bad' })).status).toBe(400);
    expect(service.mergePr).toHaveBeenCalledOnce();
  });
  it('lists PRs and validates PR detail number', async () => {
    const service = serviceFixture();
    const port = await start(service);
    expect((await call(port, 'GET', '/api/prs')).body).toEqual({ items: [{ number: 143 }] });
    expect(service.listPrs).toHaveBeenCalledWith('open');
    expect((await call(port, 'GET', '/api/prs?state=merged')).status).toBe(200);
    expect(service.listPrs).toHaveBeenCalledWith('merged');
    expect((await call(port, 'GET', '/api/prs?state=invalid')).status).toBe(400);
    expect((await call(port, 'GET', '/api/prs?state=open&state=closed')).status).toBe(400);
    expect((await call(port, 'GET', '/api/prs/143')).body).toEqual({ pr: { number: 143 }, comments: [] });
    expect((await call(port, 'GET', '/api/prs/143/files')).body).toEqual({ files: [{ path: 'src/a.ts', number: 143 }] });
    expect((await call(port, 'GET', '/api/prs/143/commits')).body).toEqual({ commits: [{ sha: head, number: 143 }] });
    expect((await call(port, 'GET', '/api/prs/0')).status).toBe(400);
    expect((await call(port, 'GET', '/api/prs/1x')).status).toBe(400);
    expect((await call(port, 'GET', '/api/prs/9007199254740992')).status).toBe(400);
    expect((await call(port, 'GET', '/api/prs/1x/files')).status).toBe(400);
    expect(service.prDetail).toHaveBeenCalledOnce();
    expect(service.prDetail).toHaveBeenCalledWith(143);
  });
  it('serves summary with CSRF token and no local diff endpoint', async () => {
    const service = serviceFixture();
    const port = await start(service);
    const summary = await call(port, 'GET', '/api/summary');
    expect(summary).toMatchObject({ status: 200, body: { branch: 'feature/review', csrfToken: expect.any(String) } });
    expect((await call(port, 'GET', '/api/session')).body).toEqual({ csrfToken: summary.body.csrfToken });
    expect((await call(port, 'GET', '/api/diff')).status).toBe(404);
  });

  it('does not expose a server endpoint for local Viewed state', async () => {
    const service = serviceFixture();
    const port = await start(service);
    const token = (await call(port, 'GET', '/api/session')).body.csrfToken as string;
    const headers = { Origin: 'http://127.0.0.1:4317', 'X-CSRF-Token': token, 'Content-Type': 'application/json' };
    expect((await call(port, 'POST', '/api/prs/143/files/viewed', headers, { path: 'src/a.ts', viewed: true })).status).toBe(404);
  });

  it('rejects foreign Host, Origin, CSRF token and malformed PR input', async () => {
    const service = serviceFixture();
    const port = await start(service);
    const token = (await call(port, 'GET', '/api/summary')).body.csrfToken as string;
    expect((await call(port, 'POST', '/api/push', { Host: 'evil.example', Origin: 'http://127.0.0.1:4317', 'X-CSRF-Token': token })).status).toBe(403);
    expect((await call(port, 'POST', '/api/push', { Origin: 'https://evil.example', 'X-CSRF-Token': token })).status).toBe(403);
    expect((await call(port, 'POST', '/api/push', { Origin: 'http://127.0.0.1:4317', 'X-CSRF-Token': 'wrong' })).status).toBe(403);
    expect((await call(port, 'POST', '/api/pr', { Origin: 'http://127.0.0.1:4317', 'X-CSRF-Token': token, 'Content-Type': 'application/json' }, { title: '', body: '', draft: false, expectedHeadSha: head })).status).toBe(400);
    expect(service.createPr).not.toHaveBeenCalled();
  });

  it('permits push only after checks', async () => {
    const service = serviceFixture();
    const port = await start(service);
    const token = (await call(port, 'GET', '/api/summary')).body.csrfToken as string;
    const headers = { Origin: 'http://127.0.0.1:4317', 'X-CSRF-Token': token, 'Content-Type': 'application/json' };
    expect((await call(port, 'POST', '/api/fetch', headers)).status).toBe(404);
    expect((await call(port, 'POST', '/api/push', headers, { expectedHeadSha: head })).status).toBe(200);
    expect(service.push).toHaveBeenCalledWith(head);
  });

  it('validates JSON, content type and routes before running commands', async () => {
    const service = serviceFixture();
    const port = await start(service);
    const token = (await call(port, 'GET', '/api/summary')).body.csrfToken as string;
    const headers = { Origin: 'http://127.0.0.1:4318', 'X-CSRF-Token': token, 'Content-Type': 'application/json' };
    expect((await call(port, 'GET', '/api/unknown')).status).toBe(404);
    expect((await call(port, 'POST', '/api/push', headers, { expectedHeadSha: 'bad' })).status).toBe(400);
    expect((await call(port, 'POST', '/api/pr', headers, { title: 'Title', body: '', draft: false, expectedHeadSha: head })).status).toBe(200);
    expect((await call(port, 'POST', '/api/push', { ...headers, 'Content-Type': 'text/plain' })).status).toBe(415);
    expect(service.push).not.toHaveBeenCalled();
    expect(service.createPr).toHaveBeenCalledWith({ title: 'Title', body: '', draft: false, expectedHeadSha: head });
  });

  it('lists remote branches and validates remote PR creation', async () => {
    const service = serviceFixture();
    const port = await start(service);
    const token = (await call(port, 'GET', '/api/session')).body.csrfToken as string;
    const headers = { Origin: 'http://127.0.0.1:4317', 'X-CSRF-Token': token, 'Content-Type': 'application/json' };
    expect(await call(port, 'GET', '/api/branches')).toEqual({ status: 200, body: { branches: [{ name: 'feature/review', sha: head }] } });
    expect((await call(port, 'POST', '/api/pr/remote', headers, { headBranch: 'feature/review', title: 'New PR', body: '', draft: true })).body).toEqual({ number: 2 });
    expect(service.createRemotePr).toHaveBeenCalledWith({ headBranch: 'feature/review', title: 'New PR', body: '', draft: true });
    for (const headBranch of ['', '-bad', 'feature..bad', 'feature//bad', 'feature/review.lock', 'x'.repeat(256)]) {
      expect((await call(port, 'POST', '/api/pr/remote', headers, { headBranch, title: 'Title', body: '', draft: false })).status).toBe(400);
    }
    expect((await call(port, 'POST', '/api/pr/remote', headers, { headBranch: 'feature/review', title: '', body: '', draft: false })).status).toBe(400);
    expect((await call(port, 'POST', '/api/pr/remote', headers, { headBranch: 'feature/review', title: 'Title', body: '', draft: 'false' })).status).toBe(400);
    expect((await call(port, 'POST', '/api/pr/remote', { ...headers, 'X-CSRF-Token': 'wrong' }, { headBranch: 'feature/review', title: 'Title', body: '', draft: false })).status).toBe(403);
    expect(service.createRemotePr).toHaveBeenCalledOnce();
  });
});
