export type FileChange = {
  path: string;
  oldPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  isBinary: boolean;
};

export type DiffLine = {
  kind: 'add' | 'remove' | 'context' | 'meta';
  oldNumber: number | null;
  newNumber: number | null;
  content: string;
};

export type FileDiff = {
  path: string;
  isBinary: boolean;
  hunks: { header: string; lines: DiffLine[] }[];
};

export function parseFiles(nameOutput: string, countOutput: string): FileChange[] {
  const counts = new Map<string, { additions: number; deletions: number; isBinary: boolean }>();
  const countParts = countOutput.split('\0');
  for (let index = 0; index < countParts.length - 1; index += 1) {
    const countRecord = countParts[index];
    const firstTab = countRecord.indexOf('\t');
    const secondTab = countRecord.indexOf('\t', firstTab + 1);
    const added = countRecord.slice(0, firstTab);
    const deleted = countRecord.slice(firstTab + 1, secondTab);
    const path = countRecord.slice(secondTab + 1);
    const isBinary = added === '-' || deleted === '-';
    let actualPath = path;
    if (!path) {
      index += 2;
      actualPath = countParts[index];
    }
    counts.set(actualPath, {
      additions: isBinary ? 0 : Number(added),
      deletions: isBinary ? 0 : Number(deleted),
      isBinary,
    });
  }

  const files: FileChange[] = [];
  const nameParts = nameOutput.split('\0');
  for (let index = 0; index < nameParts.length - 1;) {
    const rawStatus = nameParts[index++];
    const statusCode = rawStatus[0];
    const oldPath = statusCode === 'R' ? nameParts[index++] : undefined;
    const path = nameParts[index++];
    const status = statusCode === 'A' ? 'added' : statusCode === 'D' ? 'deleted' : statusCode === 'R' ? 'renamed' : 'modified';
    files.push({ path, ...(oldPath ? { oldPath } : {}), status, ...counts.get(path)! });
  }
  return files;
}

export function parseDiff(output: string, path: string): FileDiff {
  const hunks: FileDiff['hunks'] = [];
  let current: FileDiff['hunks'][number] | undefined;
  let oldNumber = 0;
  let newNumber = 0;
  for (const line of output.split('\n')) {
    if (line.startsWith('@@ ')) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (!match) continue;
      oldNumber = Number(match[1]);
      newNumber = Number(match[2]);
      current = { header: line, lines: [] };
      hunks.push(current);
    } else if (current && line !== '') {
      if (line.startsWith('+')) current.lines.push({ kind: 'add', oldNumber: null, newNumber: newNumber++, content: line.slice(1) });
      else if (line.startsWith('-')) current.lines.push({ kind: 'remove', oldNumber: oldNumber++, newNumber: null, content: line.slice(1) });
      else if (line.startsWith(' ')) current.lines.push({ kind: 'context', oldNumber: oldNumber++, newNumber: newNumber++, content: line.slice(1) });
      else current.lines.push({ kind: 'meta', oldNumber: null, newNumber: null, content: line });
    }
  }
  return { path, isBinary: output.includes('Binary files ') || output.includes('GIT binary patch'), hunks };
}

export function selectRenamePatch(output: string, oldPath: string, path: string): string {
  const patches = output.split(/(?=^diff --git )/m).filter(Boolean);
  if (patches.length <= 1) return output;
  const matching = patches.find((patch) =>
    (patch.includes(`\nrename from ${oldPath}\n`) || patch.includes(`\nrename from ${JSON.stringify(oldPath)}\n`)) &&
    (patch.includes(`\nrename to ${path}\n`) || patch.includes(`\nrename to ${JSON.stringify(path)}\n`)));
  if (!matching) throw new Error('Không xác định được bản diff của file đổi tên.');
  return matching;
}
