export function expandExpectedHttpStatus(
  value: string | undefined,
): number[] | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (/^[1-5]\d\d$/.test(normalized)) {
    return [Number(normalized)];
  }
  if (!/^[1-5]xx$/.test(normalized)) return undefined;

  const start = Number(normalized[0]) * 100;
  const statuses: number[] = [];
  for (let status = start; status < start + 100; status++) {
    statuses.push(status);
  }
  return statuses;
}
