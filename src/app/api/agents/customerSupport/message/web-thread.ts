export const webChannels = new Set(['website_chat', 'website', 'web', 'chat']);
export function websiteThread(channel: string | null, data: Record<string, unknown> | null) {
  // Historical rows can store the channel in custom_data. Neither field may contradict web delivery.
  if (data != null && (typeof data !== 'object' || Array.isArray(data) || data.is_private === true)) return false;
  const channels = [channel, data?.channel].filter(value => value != null);
  return channels.length > 0 && channels.every(value => typeof value === 'string' && webChannels.has(value))
    && !data?.channel_delivery && !data?.voice_mode && !data?.source;
}
