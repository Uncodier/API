import { routeFromAppFile } from './step-app-route';

export type AddedLines = Map<string, Set<number> | '*'>;

export function parseAddedLines(
  diff: string,
  untrackedFiles: string[] = [],
): AddedLines {
  const result: AddedLines = new Map(
    untrackedFiles.map((file) => [file, '*']),
  );
  let file = '';
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      file = '';
      continue;
    }
    if (line === '+++ /dev/null') {
      file = '';
      continue;
    }
    const fileMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (fileMatch) {
      file = fileMatch[1];
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!hunk || !file) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count === 0) continue;
    const lines =
      result.get(file) === '*'
        ? '*'
        : result.get(file) || new Set<number>();
    if (lines !== '*') {
      for (let lineNumber = start; lineNumber < start + count; lineNumber++) {
        lines.add(lineNumber);
      }
      result.set(file, lines);
    }
  }
  return result;
}

export function parseChangedTargets(diff: string): Set<string> {
  const targets = new Set<string>();
  for (const line of diff.split('\n')) {
    const match = line.match(/^--- a\/(.+)$/);
    if (!match) continue;
    const route = routeFromAppFile(match[1]);
    if (route) targets.add(route);
    if (match[1].startsWith('public/')) {
      targets.add(match[1].slice('public'.length));
    }
  }
  return targets;
}
