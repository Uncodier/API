/**
 * Assistant Protocol for WhatsApp Template Tool
 * Create templates when outside 24h reply window and send messages using templates.
 *
 * Templates may contain merge tokens ({{lead.name}}, {{site.name}}, ...). At create
 * time those tokens are rewritten to Twilio numeric placeholders ({{1}}, {{2}}, ...)
 * and the canonical token map is persisted. At send time callers either pass
 * `variables` directly or pass `lead_id` so the tool resolves them automatically.
 */

import { WhatsAppSendService } from '@/lib/services/whatsapp/WhatsAppSendService';
import { WhatsAppTemplateService } from '@/lib/services/whatsapp/WhatsAppTemplateService';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { getLeadById } from '@/lib/database/lead-db';
import {
  buildContentVariablesForLead,
  fetchSiteNameForMerge,
  placeholderPolicyToMergePolicy,
  type ContentPlaceholderPolicy,
} from '@/lib/messaging/lead-merge-fields';

export interface WhatsAppTemplateToolParams {
  action: 'create_template' | 'send_template';
  phone_number?: string;
  message?: string;
  template_id?: string;
  conversation_id?: string;
  from?: string;
  original_message?: string;
  /** Per-lead variables for numeric placeholders, as `{ "1": "value", "2": "value" }`. */
  variables?: Record<string, string>;
  /** Lead UUID used to auto-resolve `variables` from the template's placeholder_map. */
  lead_id?: string;
  /** Policy when a lead is missing a merge field value (default: strip_tokens). */
  placeholder_policy?: ContentPlaceholderPolicy;
}

async function loadTemplatePlaceholderMap(templateSid: string): Promise<string[] | undefined> {
  const { data, error } = await supabaseAdmin
    .from('whatsapp_templates')
    .select('placeholder_map')
    .eq('template_sid', templateSid)
    .maybeSingle();
  if (error || !data) return undefined;
  const raw = (data as { placeholder_map?: unknown }).placeholder_map;
  return Array.isArray(raw) ? (raw as string[]) : undefined;
}

async function formatMessageForTemplate(
  message: string,
  siteId: string,
  from?: string
): Promise<string> {
  try {
    const { data: site } = await supabaseAdmin
      .from('sites')
      .select('business_name, business_website')
      .eq('id', siteId)
      .single();
    if (!site?.business_name) return message;
    if (message.includes(site.business_name)) return message;
    let out = message + `\n\n---\n${site.business_name}`;
    if (site.business_website) out += `\n${site.business_website}`;
    return out;
  } catch {
    return message;
  }
}

/**
 * Creates the whatsappTemplate tool for the instance assistant.
 * Use when sendWhatsApp returns template_required: true (message outside 24h window).
 * Flow: 1) create_template (phone_number, message) -> get template_id; 2) send_template (template_id, phone_number, original_message).
 */
export function whatsappTemplateTool(siteId: string) {
  return {
    name: 'whatsappTemplate',
    description:
      `WhatsApp templates are required when sending to a user more than 24 hours after their last message.

Flow: 1) create_template (phone_number, message) — the message body may contain merge tokens such as {{lead.name}}, {{lead.first_name}}, {{lead.company}}, {{site.name}}, {{lead.metadata.<path>}}. They are rewritten to Twilio numeric placeholders ({{1}}, {{2}}, ...) and a placeholder_map is returned. If create_template returns template_required: false, the conversation is within the 24h window — use sendWhatsApp instead.
2) send_template (template_id, phone_number) — when the template has placeholders, pass either \`variables\` ({ "1": "Jane", "2": "Acme" }) or \`lead_id\` to resolve them automatically from the lead row.

A single template can be reused across many recipients by calling send_template N times with different variables; do NOT create a new template per recipient.`,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create_template', 'send_template'],
          description:
            'create_template: check 24h window and create or find a template. Body may contain {{lead.*}}/{{site.*}} merge tokens that are rewritten to numeric placeholders; the tool returns template_id and placeholder_map. send_template: deliver a message using an existing template_id; pass variables or lead_id when the template has placeholders.',
        },
        phone_number: {
          type: 'string',
          description: 'Recipient phone in international format (required for both actions)',
        },
        message: {
          type: 'string',
          description:
            'Template body (required for create_template). May contain merge tokens like {{lead.name}} which become numeric placeholders {{1}}, {{2}}, ... in the created template.',
        },
        template_id: {
          type: 'string',
          description: 'Template SID from create_template result (required for send_template)',
        },
        conversation_id: {
          type: 'string',
          description: 'Conversation UUID for 24h window check (optional for create_template)',
        },
        from: { type: 'string', description: 'Sender name (optional)' },
        original_message: {
          type: 'string',
          description: 'Original message text for logging (optional for send_template)',
        },
        variables: {
          type: 'object',
          description:
            'Values for numeric placeholders on send_template, e.g. { "1": "Jane", "2": "Acme" }. Keys must be strings. Ignored for templates without placeholders.',
          additionalProperties: { type: 'string' },
        },
        lead_id: {
          type: 'string',
          description:
            'Lead UUID. When provided with send_template, variables are auto-resolved from the template placeholder_map and the lead row (merge fields + site name). Ignored if `variables` is also provided.',
        },
        placeholder_policy: {
          type: 'string',
          enum: ['strip_tokens', 'skip_recipient'],
          description:
            'Behavior when a lead is missing a merge-field value on send_template with lead_id. strip_tokens (default): substitute empty string. skip_recipient: return an error so the caller can skip this lead.',
        },
      },
      required: ['action'],
    },
    execute: async (args: WhatsAppTemplateToolParams) => {
      const { action } = args;

      if (action === 'create_template') {
        const { phone_number, message, conversation_id, from } = args;
        if (!phone_number || !message) {
          throw new Error('create_template requires phone_number and message');
        }
        const windowCheck = await WhatsAppTemplateService.checkResponseWindow(
          conversation_id ?? null,
          phone_number,
          siteId
        );
        if (windowCheck.withinWindow) {
          return {
            success: true,
            template_required: false,
            within_window: true,
            window_hours_elapsed: windowCheck.hoursElapsed,
            note: 'Conversation is within 24h reply window; use sendWhatsApp to send directly.',
          };
        }
        const config = await WhatsAppSendService.getWhatsAppConfig(siteId);
        const formattedMessage = await formatMessageForTemplate(message, siteId, from);
        const existing = await WhatsAppTemplateService.findExistingTemplate(
          formattedMessage,
          siteId,
          config.phoneNumberId
        );
        if (existing?.templateSid) {
          return {
            success: true,
            template_required: true,
            template_id: existing.templateSid,
            template_status: 'approved',
            templated_body: existing.templatedBody,
            placeholder_map: existing.placeholderMap ?? [],
            has_variables: (existing.placeholderMap?.length ?? 0) > 0,
            note: 'Use send_template with this template_id to send the message. If placeholder_map is non-empty, pass `variables` or `lead_id`.',
          };
        }
        const createResult = await WhatsAppTemplateService.createTemplate(
          formattedMessage,
          config.phoneNumberId,
          config.accessToken,
          siteId
        );
        if (!createResult.success) {
          throw new Error(createResult.error ?? 'Failed to create template');
        }
        return {
          success: true,
          template_required: true,
          template_id: createResult.templateSid,
          template_status: 'created',
          templated_body: createResult.templatedBody,
          placeholder_map: createResult.placeholderMap ?? [],
          has_variables: (createResult.placeholderMap?.length ?? 0) > 0,
          note: 'Use send_template with this template_id to send the message. Template may need a short time to be approved. If placeholder_map is non-empty, pass `variables` or `lead_id`.',
        };
      }

      if (action === 'send_template') {
        const { template_id, phone_number, original_message, variables, lead_id, placeholder_policy } = args;
        if (!template_id || !phone_number) {
          throw new Error('send_template requires template_id and phone_number');
        }

        let resolvedVariables: Record<string, string> | undefined = variables;
        let unresolvedTokens: string[] = [];

        if (!resolvedVariables && lead_id) {
          const placeholderMap = await loadTemplatePlaceholderMap(template_id);
          if (placeholderMap && placeholderMap.length > 0) {
            const lead = await getLeadById(lead_id);
            if (!lead) {
              throw new Error(`send_template: lead ${lead_id} not found`);
            }
            const siteName = await fetchSiteNameForMerge(siteId);
            const mergePolicy = placeholderPolicyToMergePolicy(placeholder_policy);
            const built = buildContentVariablesForLead(placeholderMap, lead, siteName, mergePolicy);
            if (built.aborted) {
              return {
                success: false,
                status: 'skipped',
                reason: 'placeholders_unresolved',
                unresolved: built.unresolved,
                template_id,
              };
            }
            resolvedVariables = built.variables;
            unresolvedTokens = built.unresolved;
          }
        }

        const config = await WhatsAppSendService.getWhatsAppConfig(siteId);
        const sendResult = await WhatsAppTemplateService.sendMessageWithTemplate(
          phone_number.replace(/\s+/g, ''),
          template_id,
          config.phoneNumberId,
          config.accessToken,
          config.fromNumber,
          original_message ?? 'Template message',
          undefined,
          resolvedVariables
        );
        if (!sendResult.success) {
          throw new Error(
            sendResult.error ?? 'Failed to send WhatsApp message with template'
          );
        }
        return {
          success: true,
          message_id: sendResult.messageId,
          template_id,
          status: 'sent',
          ...(resolvedVariables ? { variables: resolvedVariables } : {}),
          ...(unresolvedTokens.length > 0 ? { unresolved_tokens: unresolvedTokens } : {}),
        };
      }

      throw new Error(`Invalid action: ${action}`);
    },
  };
}
