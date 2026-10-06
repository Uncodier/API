import { handleTwilioMediaAndCreateTask, type TwilioMediaDownload } from '@/lib/services/twilio/TwilioMediaTaskService';
import type { WhatsAppMediaState } from './inbound-action';

export function pendingWhatsAppMedia(media: TwilioMediaDownload[]): WhatsAppMediaState {
  return { status: 'pending', items: media.map((item, index) => ({ index, contentType: item.contentType, status: 'pending' })) };
}

export function pendingWhatsAppMessage(message: string, media: TwilioMediaDownload[], messageSid: string): string {
  for (const [index, item] of media.entries()) {
    message = message.split(item.url).join(`[media pending: ${messageSid}, attachment ${index + 1}]`);
  }
  return message + '\n[WhatsApp media pending: contents are not available yet. Do not guess or substitute another image/asset.]';
}

/** Only called after the registered message has been durably admitted. */
export async function prepareRegisteredWhatsAppMedia(params: {
  instanceId: string; siteId: string; userId: string; messageSid: string;
  message: string; media: TwilioMediaDownload[]; accountSid?: string; authToken?: string;
}): Promise<{ message: string; media: WhatsAppMediaState }> {
  // Exact original URL association is required; partial uploads never shift indexes.
  let files: Array<{ originalUrl?: string; url?: string; transcription?: string }> = [];
  if (params.accountSid && params.authToken) {
    try {
      const result = await handleTwilioMediaAndCreateTask({
        instanceId: params.instanceId, siteId: params.siteId, userId: params.userId,
        messageSid: params.messageSid, messageText: params.message, workflowOrigin: 'whatsapp',
        media: params.media, twilioAuth: { accountSid: params.accountSid, authToken: params.authToken },
      });
      if (result.success && 'files' in result && Array.isArray(result.files)) files = result.files;
    } catch {
      // Persist explicit failure, not an inaccessible provider URL or success claim.
      console.warn('WhatsApp media preparation failed; retaining unavailable attachment identities');
    }
  }
  let message = params.message;
  const items: WhatsAppMediaState['items'] = params.media.map((item, index) => {
    const file = files.find(candidate => candidate.originalUrl === item.url && candidate.url);
    const ready = Boolean(file?.url);
    const isAudio = item.contentType?.toLowerCase().startsWith('audio/');
    message = message.split(item.url).join(file?.url || `[media failed: ${params.messageSid}, attachment ${index + 1}; unavailable]`);
    if (isAudio) {
      message += file?.transcription
        ? `\n\n[Mensaje de voz transcrito, attachment ${index + 1}]: ${JSON.stringify(file.transcription)}`
        : `\n[Voice transcription failed: ${params.messageSid}, attachment ${index + 1}. Contents unavailable; do not guess.]`;
    }
    return { index, contentType: item.contentType, status: ready ? 'ready' : 'failed',
      ...(isAudio ? { transcription: file?.transcription ? 'ready' as const : 'failed' as const } : {}) };
  });
  const complete = items.every(item => item.status === 'ready' && item.transcription !== 'failed');
  const status = complete ? 'ready' : items.some(item => item.status === 'ready') ? 'partial' : 'failed';
  message += complete
    ? `\n[WhatsApp media ready: ${items.length} attachment(s) available.]`
    : '\n[WhatsApp media incomplete: failed attachments/transcriptions are unavailable. Do not guess or substitute another image/asset.]';
  return { message, media: { status, items } };
}