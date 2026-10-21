import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunner } from '../../server/git-service.js';

const originalPath = process.env.PATH;
let directory: string | undefined;

afterEach(async () => {
  process.env.PATH = originalPath;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe('command runner', () => {
  it('classifies authentication, network and other command failures without exposing stderr', async () => {
    directory = await mkdtemp(join(tmpdir(), 'pr-review-runner-'));
    const executable = join(directory, 'git');
    await writeFile(executable, '#!/bin/sh\ncase "$1" in\n  auth) echo "authentication failed: secret" >&2 ; exit 1 ;;\n  network) echo "could not resolve host" >&2 ; exit 1 ;;\n  other) echo "secret error details" >&2 ; exit 1 ;;\n  *) echo success ;;\nesac\n');
    await chmod(executable, 0o755);
    process.env.PATH = `${directory}:${originalPath}`;
    const run = createRunner(directory);
    await expect(run('git', ['ok'])).resolves.toBe('success\n');
    await expect(run('git', ['auth'])).rejects.toMatchObject({ status: 502, message: expect.stringContaining('xác thực') });
    await expect(run('git', ['network'])).rejects.toMatchObject({ status: 502, message: expect.stringContaining('kết nối') });
    await expect(run('git', ['other'])).rejects.toMatchObject({ status: 502, message: expect.not.stringContaining('secret') });
  });
});
