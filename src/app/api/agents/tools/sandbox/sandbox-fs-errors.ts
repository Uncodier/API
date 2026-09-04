export function isMissingPathError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /enoent|no such file or directory|cannot access|not a directory/i.test(msg);
}
