import { loadExactAccount } from './exact-delivery';
import { exactWhatsAppConfig } from './exact-whatsapp';
import { deliverExplicitAudio, AudioDeliveryError, markAudioPreflightFailed } from '@/lib/services/channels/explicit-audio-delivery';
import { validateResponseFormat } from '@/lib/services/channels/response-format';
import { sendChannelMessage } from '@/lib/services/zavu/client';
import { isAcceptedZavuMessage } from './exact-zavu-response';
import { WhatsAppTemplateService } from '@/lib/services/whatsapp/WhatsAppTemplateService';
import { sendTwilioWhatsAppMessage } from '@/lib/services/whatsapp/twilio-whatsapp-transport';
import type { DeliveryChannel } from './delivery-routing';
import { audioSenderIdentity } from '@/lib/services/channels/audio-sender-identity';
import { deliverZavuTemplate, TemplateDeliveryError } from '@/lib/services/whatsapp/zavu-template-delivery';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { assertAutomationSendAllowed, AutomationSendSuppressed, automationSkippedResult } from '@/lib/services/channels/automation-send-guard';

/** Approved support messages keep their exact account; audio uses its own receipt. */
export async function sendExactAudioDelivery(input: {
  siteId: string; channel: DeliveryChannel; connectionId: string; conversationId: string;
  messageId: string; text: string; recipient: string;
}) {
  try {
    validateResponseFormat('audio', input.channel);
    const account = await loadExactAccount(input.siteId, input.channel, input.connectionId);
    const config = input.channel === 'whatsapp' ? await exactWhatsAppConfig(input.siteId, account) : null;
    if (account.provider !== 'zavu' && !config) throw new AudioDeliveryError('Selected account cannot deliver audio');
    const checkWindow = async () => {
      if (input.channel !== 'whatsapp') return;
      const window = await WhatsAppTemplateService.checkResponseWindow(input.conversationId, input.recipient, input.siteId);
      if (!window.withinWindow) throw new AudioDeliveryError('Audio requires an active WhatsApp response window');
    };
    if (input.channel === 'whatsapp' && account.provider === 'zavu') {
      const { data: saved, error } = await supabaseAdmin.from('messages').select('custom_data')
        .eq('id', input.messageId).eq('conversation_id', input.conversationId).maybeSingle();
      if (error || !saved) throw new AudioDeliveryError('Saved delivery is unavailable');
      const window = await WhatsAppTemplateService.checkResponseWindow(input.conversationId, input.recipient, input.siteId);
      if (saved.custom_data?.template_delivery || !window.withinWindow) {
        return await deliverZavuTemplate({ ...input, senderId: account.config.zavu_sender_id });
      }
    } else await checkWindow();
    const messageId = await deliverExplicitAudio({ ...input,
      sender: account.provider === 'zavu'
        ? audioSenderIdentity({ provider: 'zavu', senderId: account.config.zavu_sender_id })
        : audioSenderIdentity({ provider: 'twilio', accountSid: config!.phoneNumberId, fromNumber: config!.fromNumber }),
      dispatch: async ({ audioUrl, mimeType }) => {
        const live = await loadExactAccount(input.siteId, input.channel, input.connectionId);
        if (live.id !== account.id || live.provider !== account.provider
          || JSON.stringify(live.config) !== JSON.stringify(account.config)) {
          throw new AudioDeliveryError('Selected account changed during audio preparation');
        }
        await checkWindow();
        await assertAutomationSendAllowed({ site_id: input.siteId, conversation_id: input.conversationId,
          message_id: input.messageId, message: input.text });
        if (account.provider === 'zavu') {
          const sent = await sendChannelMessage({ to: input.recipient, channel: input.channel,
            senderId: account.config.zavu_sender_id, messageType: 'audio', content: { mediaUrl: audioUrl, mimeType },
            idempotencyKey: `audio-delivery:${input.siteId}:${input.messageId}` });
          if (!isAcceptedZavuMessage(sent)) throw new AudioDeliveryError('Audio provider did not confirm delivery');
          return sent.message.id;
        }
        const sent = await sendTwilioWhatsAppMessage({ phoneNumber: input.recipient, message: '',
          accountSid: config!.phoneNumberId, authToken: config!.accessToken, fromNumber: config!.fromNumber,
          messagingServiceSid: config!.messagingServiceSid, mediaUrls: [audioUrl],
          strictSingleMessage: true, pinFromNumber: true });
        if (!sent.success) throw new AudioDeliveryError('Audio provider did not confirm delivery');
        return sent.messageId || '';
      },
    });
    return { success: true, messageId, message_id: messageId, status: 'sent' };
  } catch (error) {
    if (error instanceof AutomationSendSuppressed) return automationSkippedResult(error);
    await markAudioPreflightFailed({ ...input, ...(error instanceof TemplateDeliveryError ? { reason: error.message } : {}) });
    return { success: false, error: error instanceof TemplateDeliveryError ? error.message
      : 'Audio delivery failed or is unconfirmed; check the saved message before retrying' };
  }
}