import { supabaseAdmin } from '@/lib/database/supabase-client';
import { sendChannelMessage } from '@/lib/services/zavu/client';
import { EmailSendService } from '@/lib/services/email/EmailSendService';
import { AgentMailSendService } from '@/lib/services/email/AgentMailSendService';
import { EmailSignatureService } from '@/lib/services/email/EmailSignatureService';
import { WhatsAppTemplateService } from '@/lib/services/whatsapp/WhatsAppTemplateService';
import { sendTwilioWhatsAppMessage } from '@/lib/services/whatsapp/twilio-whatsapp-transport';
import { decryptToken } from '@/lib/utils/token-decryption';
import { agentEmailAddress, type OutreachAccount } from './policy';
import { personalizeMergeSubjectAndMessage, fetchSiteNameForMerge, buildContentVariablesForLead } from '@/lib/messaging/lead-merge-fields';
import { resolveOutreachRecipient } from './recipients';
import { getVoiceCallEligibility } from '@/lib/services/zavu/voice-call-consent';
import { placeTrackedVoiceCall } from '@/lib/services/zavu/voice-call-service';
import { assertSafeRemoteUrl } from '@/lib/security/safe-remote-url';

export interface DeliveryContext { siteId: string; message: any; conversation: any; lead: any; account: OutreachAccount; conversations?: any[] }
export type PreparedDelivery = { reason: string } | { send: () => Promise<{ success: boolean; messageId?: string }> };

async function selectedToken(siteId: string, tokenType: string, identifier: string): Promise<any> {
  const { data, error } = await supabaseAdmin.from('secure_tokens').select('*')
    .eq('site_id', siteId).eq('token_type', tokenType);
  if (error) throw error;
  // Never take another configured account's token. Old singleton unlabelled
  // credentials are usable only when there is exactly one unambiguous token.
  const matches = (data || []).filter(t => t.identifier === identifier);
  const token = matches.length === 1 ? matches[0]
    : !matches.length && data?.length === 1 && !data[0].identifier ? data[0] : null;
  if (!token) return null;
  const encrypted = token.encrypted_value || token.token_value || token.value;
  const plaintext = typeof encrypted === 'string' ? decryptToken(encrypted) : null;
  if (!plaintext) return null;
  try { return JSON.parse(plaintext); } catch { return plaintext; }
}

/** Preparation is read-only. The returned closure is the sole dispatch point. */
export async function prepareOutreachDelivery(ctx: DeliveryContext): Promise<PreparedDelivery> {
  const { siteId, message, conversation, lead, account } = ctx;
  const c = account.config;
  if (account.provider === 'zavu' && (typeof c.zavu_sender_id !== 'string' || !c.zavu_sender_id.trim())) return { reason: 'selected_account_unavailable' };
  const subject = message.custom_data?.subject || message.custom_data?.title || '';
  const siteName = await fetchSiteNameForMerge(siteId);
  const merged = personalizeMergeSubjectAndMessage(subject, message.content, lead, siteName, 'strip_unresolved');
  const text = merged.message;
  const format = message.custom_data?.message_type || message.message_type;
  const mediaUrl = message.custom_data?.media_url || message.media_url;
  if (!text?.trim() && !mediaUrl) return { reason: 'empty_message' };
  if (account.channel === 'voice' && !getVoiceCallEligibility(lead).allowed) return { reason: 'voice_call_opted_out' };
  const recipient = resolveOutreachRecipient({ siteId, lead, channel: account.channel, conversations: ctx.conversations || [conversation] });
  if (!recipient) return { reason: 'invalid_recipient' };
  const to = recipient.recipient;
  const common = { site_id: siteId, lead_id: lead.id, conversation_id: conversation.id, agent_id: message.agent_id || conversation.agent_id };
  if (account.channel === 'voice') {
    if (account.provider !== 'zavu') return { reason: 'selected_account_unavailable' };
    if (mediaUrl || !text?.trim() || text.length > 1000) return { reason: 'invalid_voice_greeting' };
    return { send: async () => {
      // Only called after central daily/message/lead claim. Call opt-outs and selected
      // site-owned sender are checked afresh by the existing tracked-call service.
      const result = await placeTrackedVoiceCall({ siteId, to, greeting: text, messageId: message.id,
        conversationId: conversation.id, leadId: lead.id, selectedConnectionId: account.id, selectedSenderId: c.zavu_sender_id,
        objective: message.custom_data?.voice_objective, additionalContext: message.custom_data?.voice_additional_context || message.custom_data?.voice_context });
      return { success: !!result.call?.id, messageId: result.call?.id };
    } };
  }
  let media: { messageType: 'image' | 'video' | 'audio' | 'document'; content: { mediaUrl: string; mimeType?: string } } | undefined;
  if (mediaUrl || (format && format !== 'text')) {
    if (account.provider !== 'zavu' || !['image', 'video', 'audio', 'document'].includes(format)
      || account.channel === 'sms' || typeof mediaUrl !== 'string') return { reason: 'unsupported_media' };
    // Validate, but never fetch untrusted media. Zavu performs media delivery.
    try { await assertSafeRemoteUrl(mediaUrl); } catch { return { reason: 'invalid_media_url' }; }
    media = { messageType: format, content: { mediaUrl } };
    const mimeType = message.custom_data?.mime_type || message.mime_type;
    if (typeof mimeType === 'string' && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(mimeType)) media.content.mimeType = mimeType;
  }
  if (account.provider === 'zavu') {
    return { send: async () => {
      // Explicit sender is mandatory. Do not use ChannelSendService's implicit
      // "first connection" lookup, or fall through to SMTP/Twilio on failure.
      const result = await sendChannelMessage({ to, text, channel: account.channel, senderId: c.zavu_sender_id,
        ...(media || {}),
        ...(account.channel === 'email' ? { subject: merged.subject || subject } : {}) });
      return { success: result?.success !== false && !!result?.message?.id, messageId: result?.message?.id };
    } };
  }
  if (account.channel !== 'email' && account.channel !== 'whatsapp') return { reason: 'selected_account_unavailable' };
  if (account.channel === 'email') {
    const signature = await EmailSignatureService.generateAgentSignature(siteId).catch(() => ({ formatted: '' }));
    const emailParams = { ...common, email: to, subject: merged.subject || subject, message: text, trackingId: message.id, signatureHtml: signature.formatted };
    if (account.provider === 'agent_email') {
      if (!process.env.AGENTMAIL_API_KEY) return { reason: 'selected_account_unavailable' };
      const address = agentEmailAddress(c)!;
      const [username, domain] = address.split('@');
      return { send: async () => {
        const result = await AgentMailSendService.sendViaAgentMail({ ...emailParams, username, domain, senderEmail: address, preserveMessageMetadata: true });
        return { success: result.success && result.status === 'sent' && !!result.external_message_id, messageId: result.external_message_id };
      } };
    }
    const token = await selectedToken(siteId, 'email', c.email);
    const tokenEmail = typeof token === 'object' && (token?.email || token?.user);
    if (!token || (tokenEmail && tokenEmail !== c.email)) return { reason: 'selected_account_unavailable' };
    const password = typeof token === 'string' ? token : token.password;
    if (!password) return { reason: 'selected_account_unavailable' };
    const smtpConfig = { user: c.email, email: c.email, password,
      smtpHost: token.smtpHost || c.outgoingServer || 'smtp.gmail.com',
      smtpPort: token.smtpPort || c.outgoingPort || 587 };
    return { send: async () => {
      const result = await EmailSendService.sendEmail({ ...emailParams, from: '', fromEmail: c.email, smtpConfig });
      return { success: result.success && result.status === 'sent' && !!(result.envelope_id || result.email_id), messageId: result.envelope_id || result.email_id };
    } };
  }
  // Legacy WhatsApp can only use this selected account's own credentials.
  // Template creation is never delegated to a workflow that could bypass the
  // cap. Reuse only an exact, approved template owned by this site's account.
  const window = await WhatsAppTemplateService.checkResponseWindow(conversation.id, to, siteId);
  if (text.length > 1500) return { reason: 'message_too_long' };
  const token = c.access_token || (account.provider === 'whatsapp' ? await selectedToken(siteId, 'twilio_whatsapp', c.account_sid) : null);
  const authToken = typeof token === 'string' ? token : token?.authToken || token?.auth_token;
  if (!authToken) return { reason: 'selected_account_unavailable' };
  let contentSid: string | undefined;
  let contentVariables: Record<string, string> | undefined;
  if (!window.withinWindow) {
    const template = await WhatsAppTemplateService.findExistingTemplate(message.content, siteId, c.account_sid,
      { approvedExactOnly: true, trackUsage: false });
    if (!template.templateSid) return { reason: 'approved_template_required' };
    const approval = await WhatsAppTemplateService.checkTemplateApprovalStatus(template.templateSid, c.account_sid, authToken);
    if (!approval.approved) return { reason: 'approved_template_required' };
    contentSid = template.templateSid;
    if (template.placeholderMap?.length) {
      contentVariables = buildContentVariablesForLead(template.placeholderMap, lead, siteName, 'strip_unresolved').variables;
    } else if (/\{\{\d+\}\}/.test(template.templatedBody || '')) {
      return { reason: 'template_variables_unavailable' };
    }
  }
  return { send: () => sendTwilioWhatsAppMessage({ phoneNumber: to, message: text, accountSid: c.account_sid,
    authToken, fromNumber: c.existingNumber || c.from_number, messagingServiceSid: c.messaging_service_sid,
    strictSingleMessage: true, contentSid, contentVariables }) };
}