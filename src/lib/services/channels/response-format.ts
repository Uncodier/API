export type ResponseFormat = 'text' | 'audio';
export const AUDIO_RESPONSE_CHANNELS = ['whatsapp', 'telegram', 'messenger'] as const;

export function validateResponseFormat(value: unknown, channel: string): ResponseFormat | undefined {
  if (value === undefined) return undefined;
  if (value !== 'text' && value !== 'audio') throw new Error('response_format must be text or audio');
  if (value === 'audio' && !AUDIO_RESPONSE_CHANNELS.includes(channel as typeof AUDIO_RESPONSE_CHANNELS[number])) {
    throw new Error('Audio responses are supported only on WhatsApp, Telegram and Messenger');
  }
  return value;
}