const NAVIGABLE_FILE_RE =
  /^src\/app\/(.*)(?:page\.(?:tsx|jsx|ts|js)|route\.(?:ts|js))$/;

export function routeFromAppFile(file: string): string | null {
  const match = file.match(NAVIGABLE_FILE_RE);
  if (!match) return null;
  const rawSegments = match[1].split('/').filter(Boolean);
  if (rawSegments.some((segment) => segment.startsWith('_'))) return null;
  const segments = rawSegments
    .filter((segment) => !(segment.startsWith('(') && segment.endsWith(')')))
    .filter((segment) => !segment.startsWith('@'))
    .map((segment) => segment.replace(/^\(\.{1,3}\)/, ''));
  return `/${segments.join('/')}`.replace(/\/+$/, '') || '/';
}
