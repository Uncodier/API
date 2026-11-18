/** Plain-text details shared by in-app notifications and their email counterparts. */
export function buildNotificationMessage(
  summary: string,
  details: ReadonlyArray<readonly [string, unknown]>,
): string {
  const lines = details.flatMap(([label, value]) => {
    if (value === null || value === undefined) return [];
    const text = String(value).trim();
    return text ? [`${label}: ${text}`] : [];
  });
  return [summary, ...lines].join('\n\n');
}