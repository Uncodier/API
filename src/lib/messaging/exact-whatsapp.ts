import type { OutreachAccount } from '@/lib/services/outreach/policy';
import { selectedToken } from './exact-credentials';
import { deliveryError } from './exact-delivery-context';
import { WhatsAppTemplateService } from '@/lib/services/whatsapp/WhatsAppTemplateService';
import { buildContentVariablesForLead } from './lead-merge-fields';
import { sendTwilioWhatsAppMessage } from '@/lib/services/whatsapp/twilio-whatsapp-transport';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { canonicalExactTemplateBody } from './exact-template-body';

export async function exactWhatsAppConfig(siteId: string, account: OutreachAccount) {
  if (account.provider === 'zavu') return null;
  const c = account.config;
  const fromNumber = c.existingNumber || c.from_number;
  if (typeof fromNumber !== 'string' || !fromNumber.trim()) {
    throw deliveryError('Selected WhatsApp connection has no exact From number.', 'EXACT_SENDER_UNAVAILABLE');
  }
  const identifiers = [c.existingNumber || c.from_number, c.account_sid].filter((value): value is string => typeof value === 'string' && !!value);
  const token = c.access_token || (account.provider === 'whatsapp'
    ? await selectedToken(siteId, 'twilio_whatsapp', identifiers) : null);
  const accessToken = typeof token === 'string' ? token : token?.authToken || token?.auth_token;
  const tokenSid = typeof token === 'object' ? token?.accountSid || token?.account_sid : undefined;
  if (!accessToken || (tokenSid && tokenSid !== c.account_sid)) {
    throw deliveryError('Selected WhatsApp credentials are unavailable.', 'EXACT_CREDENTIALS_UNAVAILABLE');
  }
  return { phoneNumberId: c.account_sid as string, accessToken: accessToken as string,
    fromNumber: fromNumber.trim(),
    messagingServiceSid: c.messaging_service_sid as string | undefined };
}

export async function sendExactTwilio(input: {
  siteId: string; account: OutreachAccount; to: string; message: string;
  rawMessage: string; conversationId?: string; lead: any; siteName: string;
  beforeDispatch: () => Promise<void>;
  templateSid?: string;
}) {
  const config = await exactWhatsAppConfig(input.siteId, input.account);
  if (!config) throw deliveryError('Twilio selection required.');
  const window = await WhatsAppTemplateService.checkResponseWindow(input.conversationId || null, input.to, input.siteId);
  let contentSid: string | undefined;
  let contentVariables: Record<string, string> | undefined;
  if (!window.withinWindow) {
    const canonicalBody = canonicalExactTemplateBody(input.rawMessage);
    let template: { templateSid?: string; placeholderMap?: string[]; templatedBody?: string };
    if (input.templateSid) {
      const { data, error } = await supabaseAdmin.from('whatsapp_templates').select('*')
        .eq('site_id', input.siteId).eq('account_sid', config.phoneNumberId).eq('template_sid', input.templateSid).maybeSingle();
      if (error || !data || data.templated_body !== canonicalBody || !['active', 'approved', 'pending'].includes(data.status)) {
        throw deliveryError('Queued template no longer matches the selected account and content.');
      }
      template = { templateSid: data.template_sid, templatedBody: data.templated_body, placeholderMap: data.placeholder_map };
    } else {
      template = await WhatsAppTemplateService.findExistingTemplate(input.rawMessage, input.siteId,
        config.phoneNumberId, { approvedExactOnly: true, trackUsage: false });
    }
    if (!template.templateSid) throw deliveryError('An approved exact template is required.', 'APPROVED_TEMPLATE_REQUIRED');
    const approval = await WhatsAppTemplateService.checkTemplateApprovalStatus(template.templateSid,
      config.phoneNumberId, config.accessToken);
    if (!approval.approved) throw deliveryError('Selected template is not approved.', 'APPROVED_TEMPLATE_REQUIRED');
    contentSid = template.templateSid;
    if (template.placeholderMap?.length) {
      contentVariables = buildContentVariablesForLead(template.placeholderMap, input.lead || {}, input.siteName, 'strip_unresolved').variables;
    } else if (/\{\{\d+\}\}/.test(template.templatedBody || '')) {
      throw deliveryError('Template variables are unavailable.');
    }
  }
  await input.beforeDispatch();
  return sendTwilioWhatsAppMessage({ phoneNumber: input.to, message: input.message,
    accountSid: config.phoneNumberId, authToken: config.accessToken, fromNumber: config.fromNumber,
    messagingServiceSid: config.messagingServiceSid, pinFromNumber: true,
    strictSingleMessage: true, contentSid, contentVariables });
}