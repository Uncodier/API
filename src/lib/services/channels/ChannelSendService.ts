import { pinnedReplyPayloadHash } from '@/lib/messaging/pinned-reply-payload';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { assertAutomationSendAllowed, AutomationSendSuppressed, automationSkippedResult } from './automation-send-guard';
import { sendChannelMessage } from '@/lib/services/zavu/client';
import { getOutstandClient } from '@/lib/integrations/outstand/client';
import { authorizeOutstandConversation } from '@/lib/integrations/outstand/conversation-access';
import { tryPrepareLongReplyAudio } from './long-reply-audio';
import { deliverExplicitAudio, AudioDeliveryError, markAudioPreflightFailed } from './explicit-audio-delivery';
import { validateResponseFormat, type ResponseFormat } from './response-format';
import { audioSenderIdentity } from './audio-sender-identity';
import { isAcceptedZavuMessage } from '@/lib/messaging/exact-zavu-response';
import { resolveAudioRouting } from './audio-routing';
import { deliverZavuTemplate, TemplateDeliveryError, type TemplateDeliveryResult } from '@/lib/services/whatsapp/zavu-template-delivery';
import { sendCommentReply } from '@/lib/services/social-comments/delivery';
import { getSiteLicensedResources, isLicensedChannelConnection, requireLicensedChannel } from '@/lib/billing/licensed-resources';
import { validateOutboundMedia } from './outbound-media';
import { requireSavedOutboundMedia } from './saved-outbound-media';
import { dispatchNativeMedia } from './native-media-delivery';
import { dispatchPinnedZavu } from './pinned-zavu-dispatch';
import { requirePinnedZavuSender, sameZavuBinding, savedZavuReply, type ExpectedZavuTurn } from './saved-zavu-reply';

export interface SendChannelMessageParams {
  site_id: string;
  channel: string; // e.g. "telegram", "messenger", "facebook", "instagram", "threads", "linkedin", "x", "youtube"
  to: string; // chat ID
  message?: string;
  message_type?: 'text' | 'image' | 'video' | 'audio' | 'document';
  media_url?: string;
  mime_type?: string;
  subject?: string;
  agent_id?: string;
  conversation_id?: string;
  lead_id?: string;
  message_id?: string;
  response_format?: ResponseFormat;
  expectedZavuTurn?: ExpectedZavuTurn;
}

export interface SendChannelMessageResult {
  receiptHandled?: boolean;
  accepted?: boolean;
  skipped?: boolean;
  reason?: string;
  delivered?: boolean;
  success: boolean;
  messageId?: string;
  deliveryKind?: 'comment';
  provider?: 'zavu' | 'outstand';
  providerStatus?: string;
  status?: number;
  error?: string;
  templateDelivery?: TemplateDeliveryResult;
}

/**
 * Reverses Mexican phone normalization accidentally applied to Zavu chat IDs.
 * A 10-digit Telegram id like 1888278689 was stored as +521888278689.
 * Strip +52 first (not +521) so the leading 1 of the chat id is kept.
 */
export function sanitizeZavuRecipient(recipient: string): string {
  if (recipient.startsWith('+52')) {
    return recipient.substring(3);
  }
  if (recipient.startsWith('+')) {
    return recipient.substring(1);
  }
  return recipient;
}

const OUTSTAND_CHANNELS = ['facebook', 'instagram', 'threads', 'linkedin', 'x', 'twitter', 'youtube'];

export class ChannelSendService {
  /**
   * Send a generic channel message (e.g. Telegram, Messenger, or Outstand comments)
   * Resolves the correct sender or metadata from the site settings or DB.
   */
  static async sendMessage(params: SendChannelMessageParams): Promise<SendChannelMessageResult> {
    try {
      if (typeof params.channel !== 'string' || (params.message !== undefined && typeof params.message !== 'string')) {
        throw Object.assign(new Error('channel and message must be strings'), { status: 400 });
      }
      params = { ...params, channel: params.channel.toLowerCase() };
      validateResponseFormat(params.response_format, params.channel);
      const media = await validateOutboundMedia(params, params.channel);
      const message = params.message || '';
      if (!params.site_id || !params.channel || !params.to || (!message.trim() && !media)) {
        throw Object.assign(new Error('site_id, channel, to, and message or media are required'), { status: 400 });
      }

      console.log(`[ChannelSendService] Sending ${params.channel} message to ${params.to} for site ${params.site_id}`);
      const scope = await assertAutomationSendAllowed(params, true);
      const pinned = await savedZavuReply(scope, params);
      const savedMedia = pinned && media ? scope?.message?.custom_data : await requireSavedOutboundMedia(params, params.channel, media);
      const savedMediaConnection = savedMedia?.connection_id;
      if (savedMediaConnection !== undefined && (typeof savedMediaConnection !== 'string' || !savedMediaConnection.trim())) {
        throw Object.assign(new Error('Saved media connection is invalid'), { status: 400 });
      }

      // Handle Outstand Comments channels
      if (!pinned && OUTSTAND_CHANNELS.includes(params.channel)) {
        let instagramMayUseZavu = params.channel === 'instagram' && !params.message_id && !params.conversation_id;
        if (params.channel === 'instagram' && params.conversation_id) {
          const { data: conversation, error: conversationError } = await supabaseAdmin
            .from('conversations')
            .select('custom_data')
            .eq('id', params.conversation_id)
            .eq('site_id', params.site_id)
            .maybeSingle();
          if (conversationError) throw conversationError;

          const outstandConversationId =
            conversation?.custom_data?.outstand_conversation_id;
          if (typeof outstandConversationId === 'string' && savedMediaConnection === undefined) {
            const client = getOutstandClient();
            await authorizeOutstandConversation(
              client,
              outstandConversationId,
              params.site_id,
            );
            await assertAutomationSendAllowed(params);
            const dispatch = () => client.sendConversationMessage(
              outstandConversationId,
              {
                ...(message.trim() ? { content: message } : {}),
                ...(media ? { media_urls: [media.content.mediaUrl] } : {}),
              },
              params.site_id,
            );
            const result = media ? await dispatchNativeMedia(params, 'outstand', dispatch,
              sent => ({ id: sent.success === true ? sent.message?.id : undefined, status: 'pending' })) : await dispatch();
            if (result.success !== true || !result.message?.id) {
              throw new Error('Outstand provider did not confirm acceptance');
            }
            return { success: true, messageId: result.message.id, provider: 'outstand' };
          }
          if (media && savedMedia && savedMediaConnection === undefined) {
            throw Object.assign(new Error('Unbound saved Instagram media requires an authorized Outstand DM conversation'), { status: 400 });
          }
          // Only a saved non-comment conversation may use the site's Zavu Instagram connection.
          // Never turn a public comment target into a DM by guessing from `to`.
          const metadata = conversation?.custom_data || {};
          instagramMayUseZavu = Boolean(conversation)
            && !String(metadata.source || '').includes('comment')
            && !metadata.outstand_comment_id && !metadata.social_comment;
        }

        if (!instagramMayUseZavu) {
          if (media) throw Object.assign(new Error('Media requires an existing Instagram DM conversation; comment replies do not support media'), { status: 400 });
          if (!params.message_id && !params.conversation_id) {
            throw new Error('Outstand replies require message_id or conversation_id to find the parent comment');
          }
          return await sendCommentReply({ ...params, message });
        }
      }

      // 1. Get site channels connections to find the zavu_sender_id for this channel type
      const siteSettings = await getSiteLicensedResources(params.site_id);
      const connections = siteSettings.channels.connections;
      if (pinned && savedMediaConnection !== undefined && pinned.connectionId !== savedMediaConnection) {
        throw Object.assign(new Error('Saved media and inbound connection disagree'), { status: 409 });
      }
      let selectedConnection: string | undefined = pinned?.connectionId ?? savedMediaConnection;
      let selectedSender: string | undefined = pinned?.senderId;
      let templateStarted = false;
      if (params.response_format === 'audio' && params.message_id && params.conversation_id) {
        const { data: saved, error } = await supabaseAdmin.from('messages').select('custom_data')
          .eq('id', params.message_id).eq('conversation_id', params.conversation_id).maybeSingle();
        if (error || !saved) throw new AudioDeliveryError('Saved audio routing is unavailable');
        const id = saved.custom_data?.connection_id;
        templateStarted = Boolean(saved.custom_data?.template_delivery);
        if (id !== undefined && (typeof id !== 'string' || !id.trim())) throw new AudioDeliveryError('Saved audio connection is invalid');
        const routing = await resolveAudioRouting({ siteId: params.site_id, conversationId: params.conversation_id,
          channel: params.channel, connectionId: id });
        if (routing.kind !== 'zavu') throw new AudioDeliveryError('Generic audio delivery requires a Zavu sender');
        if (pinned && (routing.connectionId !== pinned.connectionId || routing.senderId !== pinned.senderId)) {
          throw new AudioDeliveryError('Audio sender no longer matches the inbound connection');
        }
        selectedConnection = routing.connectionId;
        selectedSender = routing.senderId;
      }
      // Preserve stored connection order for callers without an exact destination.
      if (pinned && connections.filter(c => c.id === pinned.connectionId).length !== 1) {
        throw Object.assign(new Error('Inbound connection is unavailable or ambiguous'), { status: 409 });
      }
      const connection = connections.find(c => c.type === params.channel && c.zavu_sender_id
        && (selectedConnection === undefined || c.id === selectedConnection)
        && (selectedSender === undefined || c.zavu_sender_id === selectedSender)
        && isLicensedChannelConnection(params.channel, c));

      if (!connection?.zavu_sender_id) {
        if (pinned) throw Object.assign(new Error('Original inbound sender is unavailable'), { status: 409 });
        throw new Error(`No sender configured for channel ${params.channel} on site ${params.site_id}`);
      }

      if (media) {
        const checkWindow = async () => {
          if (params.channel !== 'whatsapp') return;
          const { WhatsAppTemplateService } = await import('@/lib/services/whatsapp/WhatsAppTemplateService');
          const window = await WhatsAppTemplateService.checkResponseWindow(pinned?.conversationId || params.conversation_id || null, params.to, params.site_id);
          if (!window.withinWindow) throw Object.assign(new Error('Media requires an active WhatsApp response window'), { status: 400 });
        };
        if (pinned) {
          const checkBinding = async (attemptId?: string) => {
            await requirePinnedZavuSender(pinned);
            await checkWindow();
            const checked = await assertAutomationSendAllowed({ ...params, ownedChannelAttemptId: attemptId }, true);
            const fresh = await savedZavuReply(checked, params);
            const data = checked?.message?.custom_data;
            const attempt = data?.native_media_delivery as { id?: unknown; state?: unknown; provider_message_id?: unknown; payload_hash?: unknown } | undefined;
            if (!data || !sameZavuBinding(pinned, fresh) || (attemptId && (attempt?.id !== attemptId
              || attempt.state !== 'attempting' || attempt.payload_hash !== pinnedReplyPayloadHash(message,data)
              || data.status !== 'reconciliation_required'
              || data.provider_message_id != null || attempt.provider_message_id != null))) {
              throw Object.assign(new Error('Native media reply binding changed before dispatch'), { status: 409 });
            }
            return data;
          };
          // Never reselect an account after claiming. Only the owner can dispatch;
          // a crash, incomplete response or lost CAS requires receipt reconciliation.
          const original = await checkBinding();
          return await dispatchPinnedZavu(pinned, message, original, async attemptId => {
            await checkBinding(attemptId);
            return await sendChannelMessage({ to: pinned.recipient, channel: pinned.channel, senderId: pinned.senderId,
              idempotencyKey: `channel-reply:${pinned.siteId}:${pinned.messageId}`, metadata: { channel_reply_attempt: attemptId },
              ...(message.trim() ? { text: message } : {}), messageType: media.messageType, content: media.content, subject: params.subject });
          }, { field: 'native_media_delivery', mediaUrl: media.content.mediaUrl, messageType: media.messageType, mimeType: media.content.mimeType });
        }
        await requireLicensedChannel(params.site_id, params.channel, connection.id, connection.zavu_sender_id);
        await checkWindow();
        await assertAutomationSendAllowed(params);
        const result = await dispatchNativeMedia(params, 'zavu', () => sendChannelMessage({
          to: params.to, channel: params.channel, senderId: connection.zavu_sender_id,
          ...(message.trim() ? { text: message } : {}),
          messageType: media.messageType, content: media.content, subject: params.subject,
        }), sent => ({ id: isAcceptedZavuMessage(sent) ? sent.message.id : undefined }));
        if (!isAcceptedZavuMessage(result)) throw new Error('Media provider did not confirm acceptance');
        return { success: true, messageId: result.message.id, provider: 'zavu' };
      }

      if (params.response_format === 'audio') {
        const checkAudioBinding = async () => {
          if (pinned) {
            await requirePinnedZavuSender(pinned);
            const current = await savedZavuReply(await assertAutomationSendAllowed(params, true), params);
            if (!sameZavuBinding(pinned, current)) throw new AudioDeliveryError('Original audio reply binding changed');
          } else {
            await assertAutomationSendAllowed(params);
          }
        };
        const checkAudioWindow = async () => {
          if (params.channel !== 'whatsapp') return;
          const { WhatsAppTemplateService } = await import('@/lib/services/whatsapp/WhatsAppTemplateService');
          const window = await WhatsAppTemplateService.checkResponseWindow(params.conversation_id || null, params.to, params.site_id);
          if (!window.withinWindow) throw new AudioDeliveryError('Audio requires an active WhatsApp response window');
        };
        if (params.channel === 'whatsapp') {
          const { WhatsAppTemplateService } = await import('@/lib/services/whatsapp/WhatsAppTemplateService');
          const window = await WhatsAppTemplateService.checkResponseWindow(params.conversation_id || null, params.to, params.site_id);
          if (templateStarted || !window.withinWindow) {
            const templateDelivery = await deliverZavuTemplate({ siteId: params.site_id, conversationId: params.conversation_id,
              messageId: params.message_id, text: message, recipient: params.to,
              connectionId: connection.id, senderId: connection.zavu_sender_id,
              ...(pinned ? { verifyBinding: checkAudioBinding } : {}) });
            return { success: true, messageId: templateDelivery.messageId, templateDelivery };
          }
        }
        const messageId = await deliverExplicitAudio({
          siteId: params.site_id, conversationId: params.conversation_id, messageId: params.message_id,
          channel: params.channel, text: message, recipient: params.to,
          sender: audioSenderIdentity({ provider: 'zavu', senderId: connection.zavu_sender_id }),
          dispatch: async ({ audioUrl, mimeType }) => {
            await requireLicensedChannel(params.site_id, params.channel, connection.id, connection.zavu_sender_id);
            await checkAudioWindow();
            await checkAudioBinding();
            const result = await sendChannelMessage({ to: params.to, channel: params.channel,
              senderId: connection.zavu_sender_id, messageType: 'audio', content: { mediaUrl: audioUrl, mimeType },
              idempotencyKey: `audio-delivery:${params.site_id}:${params.message_id}` });
            if (!isAcceptedZavuMessage(result)) throw new AudioDeliveryError('Audio provider did not confirm acceptance');
            return result.message.id;
          },
        });
        return { success: true, messageId, provider: 'zavu' };
      }

      const dispatch = async (attemptId?: string) => {
        // Check if we should send this long reply as audio
        let finalMessage = message;
        let audioUrlToAttach: string | undefined = undefined;

        // Extract a storage URL for audio generated by the agent.
        const extractedUrlRegex = /(https?:\/\/[^\s]+?\/storage\/v1\/object\/public\/[^\s]+?\.(?:wav|mp3|ogg))/i;
        const urlMatch = params.response_format === 'text' ? null : finalMessage.match(extractedUrlRegex);

        if (urlMatch && urlMatch[1]) {
          console.log(`[ChannelSendService] Detected an audio URL in the message`);
          audioUrlToAttach = urlMatch[1];
          finalMessage = finalMessage.replace(extractedUrlRegex, '').trim();
          if (finalMessage.length < 25 || finalMessage.toLowerCase().includes('aquí está tu audio')) {
             finalMessage = '';
          }
        }

        const audioReply = params.response_format === 'text' ? null : await tryPrepareLongReplyAudio({
          siteId: params.site_id,
          channel: params.channel,
          text: finalMessage,
          existingMediaUrls: audioUrlToAttach ? [audioUrlToAttach] : undefined
        });

        const finalAudioUrl = audioReply?.audioUrl || audioUrlToAttach;
        const finalMimeType = audioReply?.mimeType || (audioUrlToAttach?.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg');

        // Audio preparation may outlive the trial. Recheck the exact sender at dispatch.
        if (pinned) {
          await requirePinnedZavuSender(pinned);
          const checked = await assertAutomationSendAllowed({ ...params, ownedChannelAttemptId: attemptId }, true);
          const fresh = await savedZavuReply(checked, params);
          const attempt = checked?.message?.custom_data?.pinned_text_delivery as { id?: unknown; state?: unknown } | undefined;
          if (!sameZavuBinding(pinned, fresh) || !attemptId || attempt?.id !== attemptId || attempt.state !== 'attempting'
            || checked?.message?.custom_data?.status !== 'reconciliation_required'
            || (checked.message.custom_data.pinned_text_delivery as {payload_hash?:unknown}).payload_hash !== pinnedReplyPayloadHash(message,checked.message.custom_data)
            || checked.message.custom_data.provider_message_id) {
            throw Object.assign(new Error('Channel reply binding changed before dispatch'), { status: 409 });
          }
        } else {
          await requireLicensedChannel(params.site_id, params.channel, connection.id, connection.zavu_sender_id);
          await assertAutomationSendAllowed(params);
        }

        let result;
        const retryIdentity = attemptId ? { idempotencyKey: `channel-reply:${params.site_id}:${params.message_id}`, metadata: { channel_reply_attempt: attemptId } } : {};
        if (finalAudioUrl) {
          result = await sendChannelMessage({
            ...retryIdentity,
            to: params.to,
            channel: params.channel,
            senderId: connection.zavu_sender_id,
            messageType: 'audio',
            content: { mediaUrl: finalAudioUrl, mimeType: finalMimeType },
            subject: params.subject
          });
          // Send audio only; a separate text follow-up is outside this adapter's scope.
        } else {
          result = await sendChannelMessage({
            ...retryIdentity,
            to: params.to,
            text: finalMessage,
            channel: params.channel,
            senderId: connection.zavu_sender_id,
            subject: params.subject
          });
        }
        return result;
      };
      if (pinned && scope?.message?.custom_data) {
        return await dispatchPinnedZavu(pinned, message, scope.message.custom_data, dispatch);
      }
      if (pinned) throw Object.assign(new Error('Original reply metadata is unavailable'), { status: 409 });
      const result = await dispatch();
      return { success: true, messageId: result?.message?.id, provider: 'zavu' };
    } catch (error: any) {
      if (error instanceof AutomationSendSuppressed) {
        const { status: _status, ...skipped } = automationSkippedResult(error);
        return skipped;
      }
      if (params.response_format === 'audio') await markAudioPreflightFailed({
        siteId: params.site_id, conversationId: params.conversation_id, messageId: params.message_id,
        ...(error instanceof TemplateDeliveryError ? { reason: error.message } : {}),
      });
      console.error(`[ChannelSendService] Error sending ${params.channel} message:`, error);
      return {
        success: false,
        status: typeof error?.status === 'number' ? error.status : undefined,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
}
