import { getLeadById } from '@/lib/database/lead-db';
import { fetchSiteNameForMerge, personalizeMergeTemplate, placeholderPolicyToMergePolicy } from '@/lib/messaging/lead-merge-fields';
import { sendExactDelivery, type ExactDeliveryInput } from '@/lib/messaging/exact-delivery';
import type { DeliveryRoute } from '@/lib/messaging/delivery-routing';
import type { PublishToolParams } from './assistantProtocol';
import { createTrackedVoiceTest, isTrackedVoiceTest, preflightPublishTest, settleVoiceTestFailure } from './test-voice-delivery';
import { buildToolExecutionContext, readToolExecutionContext, type ToolExecutionContext } from '@/lib/services/tool-execution-context';

export async function preparePublishTest(siteId: string, args: PublishToolParams, text: string, subject: string | undefined, routes: DeliveryRoute[], executionContext?: ToolExecutionContext) {
  if (args.test_recipients !== undefined && (!args.test_recipients || typeof args.test_recipients !== 'object'
    || Array.isArray(args.test_recipients) || Object.entries(args.test_recipients).some(([key, value]) => !['email', 'phone'].includes(key)
      || typeof value !== 'string' || !value.trim()))) throw new Error('Invalid test_recipients.');
  const legacyLead = args.test_recipient && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(args.test_recipient) ? args.test_recipient : undefined;
  const leadId = args.test_lead_id || legacyLead;
  const lead = leadId ? await getLeadById(leadId) : null;
  if (leadId && (!lead || lead.site_id !== siteId)) throw new Error('Test lead was not found for this site.');
  const hasAgentCall = routes.some(route => route.channel === 'voice' && route.voice_mode === 'agent_call');
  const inherited = hasAgentCall ? readToolExecutionContext(executionContext, siteId) : undefined;
  const privateIntent = args.objective?.trim() || inherited?.intent;
  // Campaign/test recipients cannot inherit a different customer's conversation.
  const privateBackground = args.additional_context?.trim() || (inherited?.source.conversation_id || inherited?.source.message_id
    ? undefined : inherited?.background);
  if (/\{\{[^{}]+\}\}/.test(`${text}\n${subject ?? ''}\n${hasAgentCall ? `${privateIntent ?? ''}\n${privateBackground ?? ''}` : ''}`) && !lead) {
    throw new Error('A valid test_lead_id is required when a test message contains merge fields.');
  }
  const explicit = legacyLead ? undefined : args.test_recipient;
  const siteName = lead ? await fetchSiteNameForMerge(siteId) : undefined;
  const merge = (value: string) => {
    if (!lead) return value;
    const merged = personalizeMergeTemplate(value, lead, siteName, placeholderPolicyToMergePolicy(args.placeholders_when_unresolved));
    if (merged.aborted) throw new Error(`Unresolved merge fields: ${merged.unresolved.join(', ')}`);
    return merged.text;
  };
  const message = merge(text);
  const privateContext = hasAgentCall ? buildToolExecutionContext({
    site_id: siteId,
    intent: privateIntent ? merge(privateIntent) : undefined,
    background: privateBackground ? merge(privateBackground) : undefined,
    source: { tool: 'publish', instance_id: inherited?.source.instance_id, node_id: inherited?.source.node_id,
      content_id: args.content_id ?? inherited?.source.content_id, audience_id: args.audience_id },
  }) : undefined;
  const deliveries: ExactDeliveryInput[] = routes.map(route => {
    const to = (route.channel === 'email' ? args.test_recipients?.email : args.test_recipients?.phone)
      || explicit || (route.channel === 'email' ? lead?.email : lead?.phone);
    if (!to) throw new Error(`Test lead has no ${route.channel === 'email' ? 'email address' : 'phone/recipient identifier'}.`);
    if (route.channel === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error('Invalid test email recipient.');
    if (['whatsapp', 'sms', 'voice'].includes(route.channel) && !/^\+[1-9]\d{6,14}$/.test(to)) throw new Error('Invalid test phone recipient.');
    return { ...route, connection_id: route.connection_id!, site_id: siteId, to, message: `[TEST] ${message}`, subject: `[TEST] ${merge(subject || 'Test Subject')}`,
      lead_id: leadId, from: args.from, omit_signature: route.audience_email_mode === 'newsletter',
      placeholder_policy: args.placeholders_when_unresolved,
      ...(route.voice_mode === 'agent_call' ? {
        objective: args.objective === undefined ? undefined : merge(args.objective),
        additional_context: args.additional_context === undefined ? undefined : merge(args.additional_context),
        ...(privateContext ? { tool_execution_context: privateContext } : {}),
      } : {}),
    };
  });
  for (const delivery of deliveries) await preflightPublishTest(delivery);
  return async () => {
    // Preparation and execution may be separated by other work. Recheck every
    // route's live account/consent before the first send or tracking write.
    for (const delivery of deliveries) await preflightPublishTest(delivery);
    const results = [];
    for (const delivery of deliveries) {
      const tracked = isTrackedVoiceTest(delivery) ? await createTrackedVoiceTest(delivery) : delivery;
      const result = await sendExactDelivery(tracked);
      if (isTrackedVoiceTest(tracked)) await settleVoiceTestFailure(tracked, result);
      results.push({ ...routes[results.length], result });
    }
    const success = results.every(entry => entry.result.success);
    return results.length === 1 ? { success, type: 'single_test_send', result: results[0].result }
      : { success, type: 'single_test_send_per_route', delivery_routes: results };
  };
}