import { supabaseAdmin } from "@/lib/database/supabase-server";
import { admitChannelMessage, reconcileChannelMessage } from '@/lib/services/channels/admit-message';
export { handleInvitationStatusChanged } from "./invitation-finalization";
export { handleDomainStatusChanged } from "./domain-status";
import { getCachedJson, setCachedJson, sha256 } from "@/lib/security/upstash-rest";
import { admitZavuInboundAutomation } from './inbound-message-license';
import { resolveInboundAudioMedia } from './inbound-audio-media';
import { inboundBinding, type InboundBinding } from './inbound-claim';
import { inboundZavuRecipient } from './inbound-recipient';
import { persistDeniedZavuInbound } from './inbound-message-history';
export {
  handleVoiceCallEvent,
  resolveVoiceCallWebhookStatus,
} from "./voice-webhook-handler";

export async function findSettingsForSender(
  senderId: string,
  options?: { skipCache?: boolean }
) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(senderId)) return [];
  const cacheKey = `zavu:sender-settings:${await sha256(senderId)}`;
  if (!options?.skipCache) {
    const cached = await getCachedJson<any[]>(cacheKey);
    if (cached) return cached;
  }
  const { data, error } = await supabaseAdmin
    .from("settings")
    .select("id, site_id, channels")
    .contains("channels", {
      connections: [{ zavu_sender_id: senderId }],
    });

  if (error) {
    console.error("[Zavu Webhook] DB error finding sender:", error);
    throw error;
  }
  const settings = data || [];
  await setCachedJson(cacheKey, settings, settings.length ? 300 : 30);
  return settings;
}

async function getUserIdFromSite(siteId: string): Promise<string | undefined> {
  const { data, error } = await supabaseAdmin
    .from("sites")
    .select("user_id")
    .eq("id", siteId)
    .maybeSingle();
  if (error) {
    throw error;
  }
  return data?.user_id || undefined;
}

// These origins have a message branch in the current worker. In particular,
// SMS and unknown origins must not fall through to its legacy email branch.
const messageChannels = new Set(['whatsapp', 'email', 'telegram', 'messenger', 'facebook',
  'instagram', 'threads', 'linkedin', 'x', 'twitter', 'youtube']);

export async function handleInboundMessage(event: any, verifiedSiteId?: string, options?: {
  binding?: InboundBinding; reconcileOnly?: boolean;
}) {
  const data = event.data;
  const from = data?.from;
  if (!(typeof from === 'string' && from.trim()) && !Number.isSafeInteger(from)) {
    console.warn("[Zavu Webhook] Inbound event missing data.from");
    return;
  }

  const senderId = event.senderId || data.senderId || event.sender?.id;
  if (typeof senderId !== 'string' || !senderId) {
    console.warn('[Zavu Webhook] Invalid sender');
    return;
  }

  const sites = await findSettingsForSender(senderId, { skipCache: true });
  const binding = inboundBinding(sites, senderId, data.channel, verifiedSiteId);
  const pin = options?.binding;
  if (pin && (!binding || pin.siteId !== binding.siteId || pin.connectionId !== binding.connectionId
    || pin.channel !== binding.channel || pin.senderId !== binding.senderId)) {
    throw new Error('Zavu inbound binding changed after receipt admission');
  }
  if (!binding) return;
  const { siteId, channel, connectionId } = binding;
  const rawFrom = String(from);
  const identity = inboundZavuRecipient(rawFrom);
  const isEmail = channel === 'email' || identity.includes('@');
  const contact = isEmail ? { email: identity } : { phone: identity };
  const source = { provider: 'zavu' as const, senderId, from: rawFrom };
  const originMessageId = data.messageId || event.id;
  if (typeof originMessageId !== 'string' || !originMessageId.trim()) return;
  if (options?.reconcileOnly) {
    // Read the previously admitted turn only. Changed content, a changed
    // license or missing media cannot turn an unresolved delivery into an ACK.
    await reconcileChannelMessage({ siteId, channel, connectionId, originMessageId, ...contact, source,
      message: '', attachments: [] });
    return;
  }
  // Voice and outbound echoes never start a text turn.
  if (channel === 'voice' || (data.direction && data.direction !== 'inbound')) return;
  // Handle cases where media comes without text
  let messageText = data.text || data.body || data.caption;
  
  if (!messageText) {
    if (data.messageType === "image" || data.messageType === "video" || data.messageType === "audio" || data.messageType === "document" || data.messageType === "sticker" || data.messageType === "location" || data.messageType === "contact") {
      messageText = `[${data.messageType}]`;
    } else {
      console.warn("[Zavu Webhook] Inbound event missing message text or valid media type");
      return;
    }
  }

  if (typeof messageText !== 'string') return;
  const userId = await getUserIdFromSite(siteId);
  const history = {
    siteId, userId, channel, connectionId, senderId, from: rawFrom, message: messageText,
    originMessageId,
  };
  if (!await admitZavuInboundAutomation(history)) return;
  if (!messageChannels.has(channel)) {
    await persistDeniedZavuInbound(history);
    return;
  }
  const media = await resolveInboundAudioMedia(data, senderId);
  if (media.audioUnavailable) {
    messageText += '\n[Audio unavailable: the recording could not be retrieved. Ask for a resend or text; do not infer its contents.]';
  }

  await admitChannelMessage({
    siteId, userId, channel, connectionId, originMessageId, message: messageText,
    name: typeof data.profileName === 'string' ? data.profileName : undefined,
    ...contact, source, attachments: media.attachments,
  });
}
