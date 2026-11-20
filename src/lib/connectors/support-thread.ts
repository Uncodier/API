/** Ownership alone is not sufficient: external conversations can retain a workspace owner's user_id. */
export function isPrivateSupportThread(row: {
  lead_id: unknown; visitor_id: unknown; channel: unknown; custom_data?: unknown;
}): boolean {
  if (row.lead_id !== null || row.visitor_id !== null || (row.channel !== null && row.channel !== 'web')) return false;
  if (row.custom_data == null) return true;
  if (typeof row.custom_data !== 'object' || Array.isArray(row.custom_data)) return false;
  const metadata = row.custom_data as Record<string, unknown>;
  return !metadata.source && !metadata.voice_mode && !metadata.channel_delivery && (!metadata.channel || metadata.channel === 'web');
}