import { supabaseAdmin } from '@/lib/database/supabase-client';
import { getLeadById } from '@/lib/database/lead-db';
import {
  buildContentVariablesForLead,
  fetchSiteNameForMerge,
} from '@/lib/messaging/lead-merge-fields';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidUUID(value: string | undefined): value is string {
  return !!value && UUID_RE.test(value);
}

export async function loadTemplatePlaceholderMap(templateSid: string): Promise<string[] | undefined> {
  const { data, error } = await supabaseAdmin
    .from('whatsapp_templates')
    .select('placeholder_map')
    .eq('template_sid', templateSid)
    .maybeSingle();
  if (error || !data) return undefined;
  const raw = (data as { placeholder_map?: unknown }).placeholder_map;
  return Array.isArray(raw) ? (raw as string[]) : undefined;
}

async function loadLeadIdFromMessage(messageId: string): Promise<string | undefined> {
  const { data, error } = await supabaseAdmin
    .from('messages')
    .select('lead_id')
    .eq('id', messageId)
    .maybeSingle();
  if (error || !data?.lead_id || typeof data.lead_id !== 'string') return undefined;
  return isValidUUID(data.lead_id) ? data.lead_id : undefined;
}

export interface ResolveContentVariablesInput {
  templateSid: string;
  siteId: string;
  explicitVariables?: Record<string, string>;
  leadId?: string;
  messageId?: string;
}

export interface ResolveContentVariablesResult {
  success: boolean;
  variables?: Record<string, string>;
  error?: string;
}

/**
 * Resolves Twilio ContentVariables for a template send.
 * Explicit variables win; otherwise placeholder_map + lead row.
 */
export async function resolveContentVariables(
  input: ResolveContentVariablesInput,
): Promise<ResolveContentVariablesResult> {
  if (input.explicitVariables && Object.keys(input.explicitVariables).length > 0) {
    return { success: true, variables: input.explicitVariables };
  }

  const placeholderMap = await loadTemplatePlaceholderMap(input.templateSid);
  if (!placeholderMap || placeholderMap.length === 0) {
    return { success: true };
  }

  let leadId = isValidUUID(input.leadId) ? input.leadId : undefined;
  if (!leadId && isValidUUID(input.messageId)) {
    leadId = await loadLeadIdFromMessage(input.messageId);
  }

  if (!leadId) {
    return {
      success: false,
      error:
        'Template has placeholders but no lead_id was provided (and none could be loaded from message_id). Pass lead_id or content_variables.',
    };
  }

  const lead = await getLeadById(leadId);
  if (!lead) {
    return { success: false, error: `Lead ${leadId} not found for template variables` };
  }

  const siteName = await fetchSiteNameForMerge(input.siteId);
  const built = buildContentVariablesForLead(placeholderMap, lead, siteName, 'strip_unresolved');
  return { success: true, variables: built.variables };
}
