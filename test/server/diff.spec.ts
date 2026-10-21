import { describe, expect, it } from 'vitest';
import { parseDiff, parseFiles, selectRenamePatch } from '../../server/diff.js';

describe('diff parsing', () => {
  it('parses file statuses, counts, renames and binary files', () => {
    const names = 'A\0added.txt\0M\0binary.png\0R100\0old.txt\0new.txt\0D\0gone.txt\0';
    const counts = ['2\t0\tadded.txt', '-\t-\tbinary.png', '0\t0\t', 'old.txt', 'new.txt', '0\t3\tgone.txt', ''].join('\0');
    expect(parseFiles(names, counts)).toEqual([
      { path: 'added.txt', status: 'added', additions: 2, deletions: 0, isBinary: false },
      { path: 'binary.png', status: 'modified', additions: 0, deletions: 0, isBinary: true },
      { path: 'new.txt', oldPath: 'old.txt', status: 'renamed', additions: 0, deletions: 0, isBinary: false },
      { path: 'gone.txt', status: 'deleted', additions: 0, deletions: 3, isBinary: false },
    ]);
  });

  it('tracks hunk line numbers', () => {
    const diff = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -2,2 +2,3 @@ title\n same\n-old\n+new\n+more\n';
    expect(parseDiff(diff, 'x').hunks[0]).toEqual({
      header: '@@ -2,2 +2,3 @@ title',
      lines: [
        { kind: 'context', oldNumber: 2, newNumber: 2, content: 'same' },
        { kind: 'remove', oldNumber: 3, newNumber: null, content: 'old' },
        { kind: 'add', oldNumber: null, newNumber: 3, content: 'new' },
        { kind: 'add', oldNumber: null, newNumber: 4, content: 'more' },
      ],
    });
  });

  it('preserves tabs in a changed filename', () => {
    expect(parseFiles('M\0src/a\tb.ts\0', '2\t1\tsrc/a\tb.ts\0')).toEqual([
      { path: 'src/a\tb.ts', status: 'modified', additions: 2, deletions: 1, isBinary: false },
    ]);
  });

  it('keeps only the requested rename when multiple patches match pathspecs', () => {
    const rename = 'diff --git a/old.txt b/new.txt\nrename from old.txt\nrename to new.txt\n@@ -1 +1 @@\n-a\n+b\n';
    const unrelated = 'diff --git a/old.txt b/old.txt\n@@ -1 +1 @@\n-x\n+y\n';
    expect(selectRenamePatch(unrelated + rename, 'old.txt', 'new.txt')).toBe(rename);
    expect(selectRenamePatch(rename, 'old.txt', 'new.txt')).toBe(rename);
    expect(() => selectRenamePatch(unrelated + unrelated, 'old.txt', 'new.txt')).toThrow('Không xác định');
  });
});
