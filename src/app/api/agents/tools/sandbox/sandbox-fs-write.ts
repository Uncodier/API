/** Pure write-mode helper for sandbox_write_file (overwrite vs append). */
export function mergeWriteContent(
  existing: string | null | undefined,
  incoming: string,
  mode?: string,
): string {
  if (String(mode || '').toLowerCase() !== 'append' || existing == null) {
    return incoming;
  }
  const prefix = existing && !existing.endsWith('\n') ? `${existing}\n` : existing;
  return `${prefix}${incoming}`;
}
