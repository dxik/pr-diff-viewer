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
    listPrs: vi.fn(async () => ({ items: [{ number: 143 }] })),
    prDetail: vi.fn(async (number: number) => ({ pr: { number }, comments: [] })),
    prFiles: vi.fn(async (number: number) => ({ files: [{ path: 'src/a.ts', number }] })),
    prCommits: vi.fn(async (number: number) => ({ commits: [{ sha: head, number }] })),
    mergeOptions: vi.fn(async () => ({ methods: ['merge', 'squash', 'rebase'] })),
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
  it('exposes only existing PR and session routes', async () => {
    const service = serviceFixture();
    const port = await start(service);
    const token = (await call(port, 'GET', '/api/session')).body.csrfToken as string;
    const headers = { Origin: 'http://127.0.0.1:4317', 'X-CSRF-Token': token, 'Content-Type': 'application/json' };
    expect((await call(port, 'GET', '/api/prs')).status).toBe(200);
    for (const path of ['/api/summary', '/api/branches', '/api/push-status']) {
      expect((await call(port, 'GET', path)).status).toBe(404);
    }
    for (const path of ['/api/push', '/api/pr', '/api/pr/remote']) {
      expect((await call(port, 'POST', path, headers, {})).status).toBe(404);
    }
  });
  it('validates merge requests and requires the CSRF token', async () => {
    const service = serviceFixture();
    const port = await start(service);
    const token = (await call(port, 'GET', '/api/session')).body.csrfToken as string;
    const headers = { Origin: 'http://127.0.0.1:4317', 'X-CSRF-Token': token, 'Content-Type': 'application/json' };
    expect((await call(port, 'GET', '/api/merge-options')).body).toEqual({ methods: ['merge', 'squash', 'rebase'] });
    expect((await call(port, 'POST', '/api/prs/143/merge', headers, { expectedHeadSha: head, method: 'squash' })).body).toEqual({ number: 143 });
    expect(service.mergePr).toHaveBeenCalledWith(143, head, 'squash');
    expect((await call(port, 'POST', '/api/prs/143/merge', { ...headers, 'X-CSRF-Token': 'wrong' }, { expectedHeadSha: head, method: 'merge' })).status).toBe(403);
    expect((await call(port, 'POST', '/api/prs/0/merge', headers, { expectedHeadSha: head, method: 'merge' })).status).toBe(400);
    expect((await call(port, 'POST', '/api/prs/143/merge', headers, { expectedHeadSha: 'bad', method: 'merge' })).status).toBe(400);
    expect((await call(port, 'POST', '/api/prs/143/merge', headers, { expectedHeadSha: head, method: 'invalid' })).status).toBe(400);
    expect((await call(port, 'POST', '/api/prs/143/merge', headers, { expectedHeadSha: head })).status).toBe(400);
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
  it('does not expose a server endpoint for local Viewed state', async () => {
    const service = serviceFixture();
    const port = await start(service);
    const token = (await call(port, 'GET', '/api/session')).body.csrfToken as string;
    const headers = { Origin: 'http://127.0.0.1:4317', 'X-CSRF-Token': token, 'Content-Type': 'application/json' };
    expect((await call(port, 'POST', '/api/prs/143/files/viewed', headers, { path: 'src/a.ts', viewed: true })).status).toBe(404);
  });

  it('rejects foreign Host, Origin and CSRF token', async () => {
    const service = serviceFixture();
    const port = await start(service);
    const token = (await call(port, 'GET', '/api/session')).body.csrfToken as string;
    expect((await call(port, 'POST', '/api/prs/143/merge', { Host: 'evil.example', Origin: 'http://127.0.0.1:4317', 'X-CSRF-Token': token })).status).toBe(403);
    expect((await call(port, 'POST', '/api/prs/143/merge', { Origin: 'https://evil.example', 'X-CSRF-Token': token })).status).toBe(403);
    expect((await call(port, 'POST', '/api/prs/143/merge', { Origin: 'http://127.0.0.1:4317', 'X-CSRF-Token': 'wrong' })).status).toBe(403);
  });
});
