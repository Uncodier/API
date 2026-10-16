import { supabaseAdmin } from '@/lib/database/supabase-client';
import { canonicalExactTemplateBody } from '@/lib/messaging/exact-template-body';
import { extractMergeTokens } from '@/lib/messaging/lead-merge-fields';
import { WhatsAppTemplateService } from '@/lib/services/whatsapp/WhatsAppTemplateService';

interface PreparedExactWhatsAppTemplate {
  templateSid: string;
  templatedBody: string;
  placeholderMap: string[];
  templateStatus: 'approved' | 'pending';
}

/** Keep the shared fuzzy finder for legacy callers, but never reuse fuzzy campaign content. */
export async function prepareExactWhatsAppTemplate(input: {
  message: string; siteId: string; accountSid: string; accessToken: string;
}): Promise<PreparedExactWhatsAppTemplate> {
  const { templated, tokens } = extractMergeTokens(input.message);
  const templatedBody = canonicalExactTemplateBody(templated);
  const matches = (body: unknown, map: unknown): boolean => body === templatedBody
    && Array.isArray(map) && map.length === tokens.length
    && map.every((token, index) => token === tokens[index]);
  const existing = await WhatsAppTemplateService.findExistingTemplate(
    input.message, input.siteId, input.accountSid, { trackUsage: false },
  );
  if (existing.templateSid && matches(existing.templatedBody, existing.placeholderMap)) {
    const { data, error } = await supabaseAdmin.from('whatsapp_templates').select('*')
      .eq('site_id', input.siteId).eq('account_sid', input.accountSid)
      .eq('template_sid', existing.templateSid).maybeSingle();
    if (error) throw new Error('Unable to verify the selected WhatsApp template.');
    if (data && matches(data.templated_body, data.placeholder_map)
      && ['active', 'approved', 'pending'].includes(data.status)) {
      return { templateSid: existing.templateSid, templatedBody, placeholderMap: tokens,
        templateStatus: data.status === 'approved' ? 'approved' : 'pending' };
    }
  }

  const created = await WhatsAppTemplateService.createTemplate(
    input.message, input.accountSid, input.accessToken, input.siteId,
  );
  if (!created.success || !created.templateSid) {
    throw new Error(`Failed to create WhatsApp template: ${created.error ?? 'unknown error'}`);
  }
  if (!matches(created.templatedBody, created.placeholderMap)) {
    throw new Error('Created WhatsApp template does not match the exact campaign body and placeholder map.');
  }
  // Creation is not approval. Also verify persistence because the shared creator
  // intentionally treats reference-write errors as nonfatal for legacy sends.
  const { data, error } = await supabaseAdmin.from('whatsapp_templates')
    .update({ status: 'pending' }).eq('site_id', input.siteId).eq('account_sid', input.accountSid)
    .eq('template_sid', created.templateSid).select('*').maybeSingle();
  if (error || !data || !matches(data.templated_body, data.placeholder_map)) {
    throw new Error('Unable to persist the exact WhatsApp template reference. Do not retry blindly.');
  }
  return { templateSid: created.templateSid, templatedBody, placeholderMap: tokens, templateStatus: 'pending' };
}