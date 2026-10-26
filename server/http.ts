import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGitService, createRunner, mergeMethods, ServiceError, type GitService, type MergeMethod, type PrListState } from './git-service.js';

const appRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const mimeTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
};

function sendJson(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let text = '';
  for await (const chunk of request) {
    text += chunk;
    if (text.length > 100_000) throw new ServiceError('Dữ liệu gửi lên quá lớn.', 413);
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new ServiceError('JSON không hợp lệ.', 400);
  }
}

export function createServer(options: { service?: GitService; staticDir?: string; } = {}) {
  const service = options.service ?? createGitService(createRunner());
  const staticDir = options.staticDir ?? resolve(appRoot, 'dist');
  const csrfToken = randomBytes(32).toString('hex');

  return createHttpServer(async (request, response) => {
    try {
      const host = request.headers.host;
      if (host !== '127.0.0.1:4318') throw new ServiceError('Host không hợp lệ.', 403);
      const url = new URL(request.url ?? '/', `http://${host}`);
      if (url.pathname.startsWith('/api/')) {
        if (request.method === 'POST') {
          const origin = request.headers.origin;
          if (origin !== 'http://127.0.0.1:4317' && origin !== 'http://127.0.0.1:4318') {
            throw new ServiceError('Origin không hợp lệ.', 403);
          }
          const supplied = request.headers['x-csrf-token'];
          const actual = typeof supplied === 'string' ? supplied : '';
          const expectedBytes = Buffer.from(csrfToken);
          const actualBytes = Buffer.from(actual);
          if (expectedBytes.length !== actualBytes.length || !timingSafeEqual(expectedBytes, actualBytes)) {
            throw new ServiceError('CSRF token không hợp lệ.', 403);
          }
          if (request.headers['content-type'] && !request.headers['content-type']?.startsWith('application/json')) {
            throw new ServiceError('Content-Type phải là application/json.', 415);
          }
        }
        if (request.method === 'GET' && url.pathname === '/api/session') {
          sendJson(response, 200, { csrfToken });
        } else if (request.method === 'GET' && url.pathname === '/api/prs') {
          const states = url.searchParams.getAll('state');
          const state = states.length === 0 ? 'open' : states[0];
          if (states.length > 1 || !['open', 'merged', 'closed', 'all'].includes(state)) {
            throw new ServiceError('Trạng thái PR không hợp lệ.', 400);
          }
          sendJson(response, 200, await service.listPrs(state as PrListState));
        } else if (request.method === 'GET' && url.pathname === '/api/merge-options') {
          sendJson(response, 200, await service.mergeOptions());
        } else if (request.method === 'POST' && /^\/api\/prs\/[^/]+\/merge$/.test(url.pathname)) {
          const rawNumber = url.pathname.split('/')[3];
          const number = Number(rawNumber);
          if (!/^[1-9]\d*$/.test(rawNumber) || !Number.isSafeInteger(number)) {
            throw new ServiceError('Số PR không hợp lệ.', 400);
          }
          const body = await readJson(request);
          if (typeof body.expectedHeadSha !== 'string' || !/^[0-9a-f]{40,64}$/.test(body.expectedHeadSha)) {
            throw new ServiceError('HEAD SHA không hợp lệ.', 400);
          }
          if (typeof body.method !== 'string' || !mergeMethods.includes(body.method as MergeMethod)) {
            throw new ServiceError('Cách merge không hợp lệ.', 400);
          }
          sendJson(response, 200, await service.mergePr(number, body.expectedHeadSha, body.method as MergeMethod));
        } else if (request.method === 'GET' && url.pathname.startsWith('/api/prs/')) {
          const match = /^\/api\/prs\/([^/]+)(?:\/(files|commits))?$/.exec(url.pathname);
          const rawNumber = match?.[1] ?? '';
          const number = Number(rawNumber);
          if (!/^[1-9]\d*$/.test(rawNumber) || !Number.isSafeInteger(number)) {
            throw new ServiceError('Số PR không hợp lệ.', 400);
          }
          if (match?.[2] === 'files') sendJson(response, 200, await service.prFiles(number));
          else if (match?.[2] === 'commits') sendJson(response, 200, await service.prCommits(number));
          else sendJson(response, 200, await service.prDetail(number));
        } else {
          throw new ServiceError('API không tồn tại.', 404);
        }
        return;
      }

      if (request.method !== 'GET' && request.method !== 'HEAD') throw new ServiceError('Phương thức không hợp lệ.', 405);
      const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      const filePath = resolve(staticDir, relative);
      if (!filePath.startsWith(staticDir + sep) && filePath !== staticDir) throw new ServiceError('Đường dẫn không hợp lệ.', 403);
      let content: Buffer;
      try { content = await readFile(filePath); }
      catch { content = await readFile(resolve(staticDir, 'index.html')); }
      response.writeHead(200, { 'Content-Type': mimeTypes[extname(filePath)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) {
      const failure = error instanceof ServiceError ? error : new ServiceError('Lỗi máy chủ. Thử lại sau.');
      sendJson(response, failure.status, { error: failure.message });
    }
  });
}
