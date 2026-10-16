import { supabaseAdmin } from '@/lib/database/supabase-client';
import { resolveDeliveryAccount, parseDeliveryRoutes, type DeliveryChannel } from './delivery-routing';
import { loadExactDeliveryContext, deliveryError } from './exact-delivery-context';
import { selectedToken } from './exact-credentials';
import { exactWhatsAppConfig, sendExactTwilio } from './exact-whatsapp';
import { sendChannelMessage } from '@/lib/services/zavu/client';
import { assertVoiceCallAllowed, placeTrackedVoiceCall } from '@/lib/services/zavu/voice-call-service';
import { agentEmailAddress } from '@/lib/services/outreach/policy';
import { EmailSendService } from '@/lib/services/email/EmailSendService';
import { AgentMailSendService } from '@/lib/services/email/AgentMailSendService';
import { EmailSignatureService } from '@/lib/services/email/EmailSignatureService';
import { readToolExecutionContext } from '@/lib/services/tool-execution-context';
import { exactEmailContent } from './exact-email-content';
import { isAcceptedZavuMessage } from './exact-zavu-response';
import { fetchSiteNameForMerge, personalizeMergeSubjectAndMessage, placeholderPolicyToMergePolicy,
  buildContentVariablesForLead, type ContentPlaceholderPolicy } from './lead-merge-fields';

export interface ExactDeliveryInput {
  site_id: string;
  channel: DeliveryChannel;
  connection_id: string;
  to: string;
  message: string;
  subject?: string;
  email?: string;
  lead_id?: string;
  conversation_id?: string;
  message_id?: string;
  agent_id?: string;
  from?: string;
  omit_signature?: boolean;
  placeholder_policy?: ContentPlaceholderPolicy;
  voice_mode?: 'tts' | 'agent_call';
  objective?: string;
  additional_context?: string;
  tool_execution_context?: unknown;
  audience_id?: string;
  language?: string;
  max_duration_minutes?: number;
  /** Internal durable receipt hook, called only once preparation succeeds. */
  before_dispatch?: () => Promise<void>;
}

export interface ExactDeliveryResult {
  success: boolean;
  status?: string;
  messageId?: string;
  message_id?: string;
  external_message_id?: string;
  envelope_id?: string;
  email_id?: string;
  callId?: string;
  deliveryId?: string;
  duplicate?: boolean;
  delivery_attempted?: boolean;
  agentmail_message_id?: string;
  agentmail_thread_id?: string;
  agentmail_inbox_id?: string;
  error?: { code: string; message: string };
}

export async function loadExactAccount(siteId: string, channel: DeliveryChannel, connectionId: string) {
  parseDeliveryRoutes({ channel, connection_id: connectionId });
  if (!siteId || !connectionId) throw deliveryError('Exact site and connection are required.');
  const { data, error } = await supabaseAdmin.from('settings').select('channels').eq('site_id', siteId).single();
  if (error || !data) throw deliveryError('Site delivery settings are unavailable.');
  return resolveDeliveryAccount(data.channels, { channel, connection_id: connectionId });
}

/** Null means a valid Zavu WhatsApp destination; invalid selections always throw. */
export async function getExactWhatsAppConfig(siteId: string, connectionId: string) {
  return exactWhatsAppConfig(siteId, await loadExactAccount(siteId, 'whatsapp', connectionId));
}

/** Server-only adapter. Caller must authorize the site before invoking it. No provider fallback. */
export async function sendExactDelivery(input: ExactDeliveryInput): Promise<ExactDeliveryResult> {
  let attempted = false;
  let preparedAccount: Awaited<ReturnType<typeof loadExactAccount>> | undefined;
  const beforeDispatch = async () => {
    const live = await loadExactAccount(input.site_id, input.channel, input.connection_id);
    if (!preparedAccount || live.id !== preparedAccount.id || live.provider !== preparedAccount.provider
      || JSON.stringify(live.config) !== JSON.stringify(preparedAccount.config)) {
      throw deliveryError('Selected account changed during preparation.');
    }
    await input.before_dispatch?.();
    attempted = true;
  };
  try {
    parseDeliveryRoutes({ channel: input.channel, connection_id: input.connection_id,
      ...(input.voice_mode !== undefined ? { voice_mode: input.voice_mode } : {}) });
    if (!input.connection_id || typeof input.to !== 'string' || !input.to.trim()
      || typeof input.message !== 'string' || !input.message.trim()) throw deliveryError('Invalid exact delivery input.');
    if (input.channel === 'email' && !EmailSendService.isValidEmail(input.to)) throw deliveryError('Invalid email recipient.');
    if (['sms', 'whatsapp', 'voice'].includes(input.channel) && !/^\+[1-9]\d{6,14}$/.test(input.to)) {
      throw deliveryError('Invalid phone recipient.');
    }
    const context = await loadExactDeliveryContext(input);
    const data = context.customData;
    const rawMessage = context.message?.content ?? input.message;
    const subject = data.subject || data.title || input.subject || '';
    const siteName = await fetchSiteNameForMerge(input.site_id);
    const numberedVariables = Array.isArray(data.placeholder_map) && data.placeholder_map.length
      ? buildContentVariablesForLead(data.placeholder_map, context.lead || {}, siteName, 'strip_unresolved').variables : undefined;
    const numberedMessage = numberedVariables ? rawMessage.replace(/\{\{(\d+)\}\}/g,
      (_token: string, index: string) => numberedVariables[index] ?? '') : rawMessage;
    const merged = personalizeMergeSubjectAndMessage(subject, numberedMessage, context.lead || {}, siteName,
      placeholderPolicyToMergePolicy(input.placeholder_policy));
    if (merged.aborted) return { success: false, status: 'skipped',
      error: { code: 'PLACEHOLDERS_UNRESOLVED', message: 'Unresolved delivery merge fields.' } };
    const voiceMode = data.voice_mode || input.voice_mode || 'tts';
    if (input.channel === 'voice') await assertVoiceCallAllowed(input.site_id, context.leadId, input.to);
    const signature = input.channel === 'email' && !input.omit_signature && data.audience_email_mode !== 'newsletter'
      ? await EmailSignatureService.generateAgentSignature(input.site_id).catch(() => ({ formatted: '' })) : { formatted: '' };
    // Re-read live inventory after preparation, immediately before choosing credentials/dispatch.
    const account = await loadExactAccount(input.site_id, input.channel, context.connectionId!);
    preparedAccount = account;
    const c = account.config;
    let result: ExactDeliveryResult;
    if (input.channel === 'voice' && voiceMode === 'agent_call') {
      if (!input.message_id) throw deliveryError('Agent calls require a tracked message.');
      await beforeDispatch();
      const call = await placeTrackedVoiceCall({ siteId: input.site_id, to: input.to, greeting: merged.message,
        messageId: input.message_id, conversationId: context.conversationId, leadId: context.leadId,
        audienceId: input.audience_id, selectedConnectionId: account.id, selectedSenderId: c.zavu_sender_id,
        objective: data.voice_objective || input.objective,
        additionalContext: data.voice_additional_context || data.voice_context || input.additional_context,
        executionContext: readToolExecutionContext(data.tool_execution_context || input.tool_execution_context, input.site_id),
        language: input.language, maxDurationMinutes: input.max_duration_minutes });
      result = { success: !!call.call?.id, status: call.call?.status || 'queued', messageId: call.call?.id,
        callId: call.call?.id, deliveryId: call.deliveryId, duplicate: call.duplicate };
    } else if (account.provider === 'zavu') {
      const emailContent = input.channel === 'email'
        ? exactEmailContent(merged.message, siteName || '', signature.formatted, input.message_id) : undefined;
      await beforeDispatch();
      const sent = await sendChannelMessage({ to: input.to, text: emailContent?.text ?? merged.message, channel: input.channel,
        senderId: c.zavu_sender_id, ...(input.channel === 'email' ? { subject: merged.subject } : {}),
        ...(emailContent ? { htmlBody: emailContent.htmlBody } : {}),
        ...(input.message_id ? { idempotencyKey: `exact-delivery:${input.site_id}:${input.message_id}` } : {}) });
      result = { success: isAcceptedZavuMessage(sent), status: sent?.message?.status, messageId: sent?.message?.id };
    } else if (input.channel === 'whatsapp') {
      const sent = await sendExactTwilio({ siteId: input.site_id, account, to: input.to,
        message: merged.message, rawMessage, conversationId: context.conversationId, lead: context.lead, siteName: siteName || '', beforeDispatch,
        templateSid: data.template_sid });
      result = { success: sent.success, status: 'sent', messageId: sent.messageId,
        ...(!sent.success ? { error: { code: 'EXACT_PROVIDER_FAILED', message: 'Selected WhatsApp provider failed.' } } : {}) };
    } else {
      const emailParams = { site_id: input.site_id, email: input.to, subject: merged.subject || subject, message: merged.message,
        agent_id: input.agent_id || context.message?.agent_id, conversation_id: context.conversationId,
        lead_id: context.leadId, trackingId: input.message_id, signatureHtml: signature.formatted };
      if (account.provider === 'agent_email') {
        if (!process.env.AGENTMAIL_API_KEY) throw deliveryError('Selected AgentMail credentials are unavailable.');
        const address = agentEmailAddress(c)!;
        const [username, domain] = address.split('@');
        await beforeDispatch();
        const sent = await AgentMailSendService.sendViaAgentMail({ ...emailParams,
          username, domain, senderEmail: address, preserveMessageMetadata: true });
        result = { ...sent, success: sent.success && sent.status === 'sent' && !!sent.external_message_id,
          messageId: sent.external_message_id, agentmail_message_id: sent.external_message_id,
          agentmail_thread_id: sent.thread_id, agentmail_inbox_id: address };
      } else if (account.provider === 'email') {
        const token = await selectedToken(input.site_id, 'email', c.email);
        const tokenEmail = typeof token === 'object' && (token?.email || token?.user);
        const password = typeof token === 'string' ? token : token?.password;
        if (!password || (tokenEmail && tokenEmail !== c.email)) throw deliveryError('Selected SMTP credentials are unavailable.');
        await beforeDispatch();
        const sent = await EmailSendService.sendEmail({ ...emailParams, from: input.from || '', fromEmail: c.email,
          smtpConfig: { user: c.email, email: c.email, password, smtpHost: token.smtpHost || c.outgoingServer || 'smtp.gmail.com',
            smtpPort: token.smtpPort || c.outgoingPort || 587 } });
        result = { ...sent, success: sent.success && sent.status === 'sent' && !!(sent.envelope_id || sent.email_id),
          messageId: sent.envelope_id || sent.email_id };
      } else throw deliveryError('Unsupported exact delivery provider.');
    }
    if (!result.success) return { success: false, delivery_attempted: attempted,
      error: { code: 'EXACT_PROVIDER_FAILED', message: 'Selected provider did not accept delivery.' } };
    return { ...result, delivery_attempted: attempted, message_id: result.messageId, external_message_id: result.external_message_id || result.messageId };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'EXACT_DELIVERY_FAILED';
    // Provider errors can echo credentials or content. Do not surface raw errors.
    return { success: false, delivery_attempted: attempted, error: { code, message: 'Exact delivery failed. Check the selected active connection and credentials before retrying.' } };
  }
}