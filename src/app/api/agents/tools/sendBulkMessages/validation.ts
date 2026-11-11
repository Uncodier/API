import type { SendBulkMessagesToolParams } from './definition';
import type { DeliveryRoute } from '@/lib/messaging/delivery-routing';
import { canonicalExactTemplateBody } from '@/lib/messaging/exact-template-body';
import { validateOutboundMediaShape } from '@/lib/services/channels/outbound-media';

export function validateBulkRoutes(args: SendBulkMessagesToolParams, routes: DeliveryRoute[]): void {
  if (typeof args.audience_id !== 'string' || !args.audience_id.trim() || typeof args.message !== 'string'
    || (!args.message.trim() && !routes.every(route => validateOutboundMediaShape(args, route.channel)))) throw new Error('audience_id and message or media are required.');
  if (routes.some(route => route.channel === 'email') && (typeof args.subject !== 'string' || !args.subject.trim())) throw new Error('Subject is required for email delivery.');
  if ((args.objective || args.additional_context) && !routes.some(route => route.channel === 'voice' && route.voice_mode === 'agent_call')) {
    throw new Error('objective and additional_context are only valid for Voice agent calls.');
  }
  for (const route of routes) {
    if (route.channel === 'messenger' || route.channel === 'instagram') throw new Error('Bulk Messenger/Instagram recipient resolution is not supported; use a saved conversation send');
    const media = validateOutboundMediaShape(args, route.channel);
    if (args.response_format !== undefined && args.response_format !== 'text') throw new Error('Bulk generated audio is not supported');
    if (media && route.channel === 'whatsapp' && route.connection_id?.startsWith('legacy:')) throw new Error('Legacy WhatsApp bulk media templates are not supported; send media within an open response window instead');
    if (route.channel === 'whatsapp' && route.connection_id?.startsWith('legacy:')) canonicalExactTemplateBody(args.message);
    if (route.voice_mode === 'agent_call' && args.message.length > 1000) throw new Error('Voice agent call greeting must not exceed 1000 characters.');
    if (args.objective && args.objective.length > 500) throw new Error('Voice call objective must not exceed 500 characters.');
    if (args.additional_context && args.additional_context.length > 4000) throw new Error('Voice call additional_context must not exceed 4000 characters.');
  }
}

