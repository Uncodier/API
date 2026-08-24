export function matchesFilter(row: Record<string, unknown>, filter?: Record<string, unknown>): boolean {
  if (!filter || Object.keys(filter).length === 0) return true;
  return Object.entries(filter).every(([key, expected]) => row[key] === expected);
}
