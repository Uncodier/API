import { receiveZavuWebhook } from '@/lib/services/zavu/receive-webhook';
import { reconcilePinnedDeliveryEvent } from '@/lib/services/zavu/pinned-delivery-events';
import { reconcileAudioDeliveryEvent } from '@/lib/services/zavu/audio-delivery-events';
import { reconcileTemplateDeliveryEvent } from '@/lib/services/zavu/template-delivery-events';
import { handleWhatsAppAppEcho, isWhatsAppAppEcho } from '@/lib/services/zavu/whatsapp-app-echo';
import { handleDomainStatusChanged, handleInvitationStatusChanged, handleVoiceCallEvent } from '@/lib/services/zavu/webhook-handlers';

export async function POST(request: Request) {
  return receiveZavuWebhook(request, handleLifecycleEvent);
}

async function handleLifecycleEvent(event: any, verifiedSiteId?: string, verifiedConnectionId?: string) {
  if (isWhatsAppAppEcho(event)) {
    await handleWhatsAppAppEcho(event);
    return;
  }
  switch (event.type) {
    case 'invitation.status_changed':
      await handleInvitationStatusChanged(event.data || {});
      break;
    case 'domain.verified':
    case 'domain.failed':
      await handleDomainStatusChanged(event.data || {}, event.type);
      break;
    case 'message.sending':
      await reconcilePinnedDeliveryEvent(event, verifiedSiteId, verifiedConnectionId);
      break;
    case 'message.queued':
    case 'message.sent':
    case 'message.delivered':
    case 'message.read':
    case 'message.failed':
      if (await reconcilePinnedDeliveryEvent(event, verifiedSiteId, verifiedConnectionId)) break;
      await reconcileTemplateDeliveryEvent(event);
      await reconcileAudioDeliveryEvent(event);
      break;
    case 'call.initiated':
    case 'call.answered':
    case 'call.completed':
    case 'call.failed':
      await handleVoiceCallEvent(event);
      break;
    default:
      // Includes conversation.new: only message.inbound can start a turn.
      console.log(`[Zavu Webhook] No action for ${event.type}`);
  }
}