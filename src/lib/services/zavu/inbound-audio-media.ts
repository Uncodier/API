import { zavuFetch } from './client';
import { zavuSupportAttachments } from '../customer-support-attachments';

const ATTEMPT_TIMEOUT_MS = 1500;
const RETRY_DELAY_MS = 150;

function attachmentsFor(data: any) {
  // Keep all URL validation/deduplication in the shared normalizer.
  return zavuSupportAttachments(data);
}

/** Call only after the webhook's unique sender/site binding and admission checks. */
export async function resolveInboundAudioMedia(data: any, senderId: string) {
  const attachments = attachmentsFor(data);
  if (data.messageType !== 'audio' || attachments.length > 0) {
    return { attachments, audioUnavailable: false };
  }
  const unavailable = { attachments, audioUnavailable: true };
  // Never substitute an event ID for the provider's message ID.
  if (typeof data.messageId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(data.messageId)
    || typeof senderId !== 'string' || !senderId
    || typeof data.from !== 'string' || !data.from
    || typeof data.channel !== 'string' || !data.channel) return unavailable;

  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Race as well as abort so even a stalled transport cannot hold admission open.
      const payload = await Promise.race([
        zavuFetch<any>(`/messages/${encodeURIComponent(data.messageId)}`, {
          method: 'GET', signal: controller.signal, redirect: 'error',
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error('Audio lookup timed out'));
          }, ATTEMPT_TIMEOUT_MS);
        }),
      ]);
      // Only the documented envelope is accepted. No coercion or identity normalization.
      const message = payload?.message;
      if (!message || message.id !== data.messageId || message.senderId !== senderId
        || message.from !== data.from || message.channel !== data.channel
        || message.direction !== 'inbound' || message.messageType !== 'audio'
        || (data.to !== undefined && message.to !== data.to)) return unavailable;
      const resolved = attachmentsFor({ messageType: 'audio', content: message.content });
      if (resolved.length) return { attachments: resolved, audioUnavailable: false };
    } catch {
      // Provider errors may contain credentials or message content: never propagate/log them.
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (attempt === 0) await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
  }
  return unavailable;
}
