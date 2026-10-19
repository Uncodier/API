/** Offline projection fixture; never used by production execution. */
export function licensedRpcResult(channels: any, social_media: any[] = []) {
  const value = { data: { channels: { ...channels, connections: (channels.connections || [])
    .map((row: any) => ({ ...row, license_suspended: row.license_suspended ?? false })) },
  social_media, effective_plan: 'engine' }, error: null };
  return { abortSignal: () => Promise.resolve(value) };
}