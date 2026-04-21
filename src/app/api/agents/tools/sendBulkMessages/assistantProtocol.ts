/**
 * Assistant Protocol for Send Bulk Messages Tool
 *
 * Sends a message to every lead in an audience via WhatsApp or email.
 * Iterates through all pages, tracks per-lead send status, and returns
 * a summary with totals.
 */

import { supabaseAdmin } from '@/lib/database/supabase-client';
import {
  getAudienceById,
  getAudiencePageForSending,
  updateAudienceLeadStatus,
} from '@/lib/database/audience-db';
import { getContentById } from '@/lib/database/content-db';
import type { DbLead } from '@/lib/database/lead-db';
import type { ContentPlaceholderPolicy } from '@/lib/messaging/lead-merge-fields';
import {
  buildContentVariablesForLead,
  extractMergeTokens,
  fetchSiteNameForMerge,
  personalizeMergeSubjectAndMessage,
  placeholderPolicyToMergePolicy,
} from '@/lib/messaging/lead-merge-fields';
import { sendEmailCore } from '../sendEmail/route';
import { WhatsAppSendService } from '@/lib/services/whatsapp/WhatsAppSendService';
import { WhatsAppTemplateService } from '@/lib/services/whatsapp/WhatsAppTemplateService';

// Función para validar UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// Función para encontrar un agente de ventas activo para un sitio
async function findActiveSalesAgent(siteId: string): Promise<{agentId: string, userId: string} | null> {
  try {
    if (!siteId || !isValidUUID(siteId)) {
      return null;
    }
    
    const { data, error } = await supabaseAdmin
      .from('agents')
      .select('id, user_id')
      .eq('site_id', siteId)
      .eq('role', 'Sales')
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1);
    
    if (error || !data || data.length === 0) {
      return null;
    }
    
    return {
      agentId: data[0].id,
      userId: data[0].user_id
    };
  } catch (error) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SendBulkMessagesToolParams {
  audience_id: string;
  channel: 'whatsapp' | 'email';
  message: string;
  subject?: string;
  from?: string;
  /** Email only: `mail` (default) queues via conversations; `newsletter` sends immediately with tracking, no conversations. */
  audience_email_mode?: 'mail' | 'newsletter';
  /** Optional content row whose metadata.placeholders.when_unresolved controls unknown {{...}} tokens. */
  content_id?: string;
  /** Override policy when content_id is absent or has no placeholders config. Default: strip_tokens. */
  placeholder_policy?: ContentPlaceholderPolicy;
}

async function resolvePlaceholderPolicy(
  contentId: string | undefined,
  override: ContentPlaceholderPolicy | undefined,
): Promise<ContentPlaceholderPolicy> {
  if (override) return override;
  if (!contentId) return 'strip_tokens';
  const row = await getContentById(contentId);
  const w = row?.metadata && typeof row.metadata === 'object'
    ? (row.metadata as Record<string, unknown>).placeholders
    : undefined;
  if (w && typeof w === 'object' && w !== null && 'when_unresolved' in w) {
    const v = (w as { when_unresolved?: string }).when_unresolved;
    if (v === 'skip_recipient' || v === 'strip_tokens') return v;
  }
  return 'strip_tokens';
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function sendBulkMessagesTool(siteId: string) {
  const execute = async (args: SendBulkMessagesToolParams) => {
    const { audience_id, channel, message, subject, from, content_id: contentIdArg, placeholder_policy } = args;
    const audience_email_mode = args.audience_email_mode ?? 'mail';

    if (!audience_id) return { success: false, error: 'Missing required field: audience_id' };
    if (!channel) return { success: false, error: 'Missing required field: channel' };
    if (!message) return { success: false, error: 'Missing required field: message' };
    if (channel === 'email' && !subject) {
      return { success: false, error: 'Missing required field for email: subject' };
    }
    if (audience_email_mode === 'newsletter' && channel !== 'email') {
      return {
        success: false,
        error: 'audience_email_mode "newsletter" is only valid when channel is "email".',
      };
    }

    const audience = await getAudienceById(audience_id);
    if (!audience) return { success: false, error: 'Audience not found' };
    if (audience.site_id !== siteId) return { success: false, error: 'Audience does not belong to this site' };
    if (audience.status !== 'ready') {
      return { success: false, error: `Audience is not ready (status: ${audience.status})` };
    }

    const placeholderPolicyResolved = await resolvePlaceholderPolicy(contentIdArg, placeholder_policy);

    // Immediate send with open/click tracking (sendEmail pipeline); no conversation rows.
    if (channel === 'email' && audience_email_mode === 'newsletter') {
      const agent = await findActiveSalesAgent(siteId);
      const agentId = agent?.agentId ?? undefined;

      const totalPages = Math.ceil(audience.total_count / audience.page_size);
      let totalSent = 0;
      let totalFailed = 0;
      let totalSkipped = 0;

      for (let page = 1; page <= totalPages; page++) {
        const { leads } = await getAudiencePageForSending(audience_id, page);
        if (leads.length === 0) continue;

        for (const lead of leads) {
          const leadId = lead.id as string;

          try {
            if (!lead.email) {
              await updateAudienceLeadStatus(audience_id, leadId, 'skipped', 'No email address');
              totalSkipped++;
              continue;
            }

            const result = await sendEmailCore({
              site_id: siteId,
              email: lead.email,
              subject: subject!,
              message,
              from,
              lead_id: leadId,
              agent_id: agentId,
              omit_signature: true,
              placeholder_policy: placeholderPolicyResolved,
            });

            const ok = result.success && result.status !== 'skipped';

            if (ok) {
              await updateAudienceLeadStatus(audience_id, leadId, 'sent');
              totalSent++;
            } else {
              const errMsg = result.error?.message
                ?? (result.status === 'skipped' ? 'Email send skipped' : 'Email send failed');
              const isUnresolved = result.error?.code === 'PLACEHOLDERS_UNRESOLVED';
              await updateAudienceLeadStatus(
                audience_id,
                leadId,
                isUnresolved ? 'skipped' : 'failed',
                errMsg,
              );
              if (isUnresolved) totalSkipped++;
              else totalFailed++;
            }
          } catch (err: any) {
            await updateAudienceLeadStatus(
              audience_id,
              leadId,
              'failed',
              err?.message ?? 'Unexpected error',
            );
            totalFailed++;
          }
        }
      }

      const totalRemaining = audience.total_count - totalSent - totalFailed - totalSkipped;

      return {
        success: true,
        audience_id,
        channel,
        audience_email_mode: 'newsletter' as const,
        total_sent: totalSent,
        total_failed: totalFailed,
        total_skipped: totalSkipped,
        total_remaining: totalRemaining,
        total_in_audience: audience.total_count,
      };
    }

    const mergePolicy = placeholderPolicyToMergePolicy(placeholderPolicyResolved);
    const siteName = await fetchSiteNameForMerge(siteId);

    const totalPages = Math.ceil(audience.total_count / audience.page_size);
    let totalSent = 0;
    let totalFailed = 0;
    let totalSkipped = 0;

    // Buscar agente activo una sola vez por campaña
    const agent = await findActiveSalesAgent(siteId);
    // Usaremos un ID nulo si no hay agente de ventas (se asignará al sistema o quedará nulo)
    const agentId = agent?.agentId || null;
    const userId = agent?.userId || null;

    // -------------------------------------------------------------------------
    // WhatsApp path: create/reuse ONE template with numeric placeholders and
    // queue per-lead ContentVariables. The template body is kept abstract
    // (e.g. "Hi {{1}}, ..."); personalization happens via Twilio variables at
    // delivery time, so a single approved template serves the whole campaign.
    // -------------------------------------------------------------------------
    if (channel === 'whatsapp') {
      const { templated: abstractBody, tokens: campaignTokens } = extractMergeTokens(message);

      let templateSid: string | undefined;
      let placeholderMap: string[] = campaignTokens;
      let templateStatus: 'approved' | 'pending' = 'approved';

      try {
        const config = await WhatsAppSendService.getWhatsAppConfig(siteId);
        const existing = await WhatsAppTemplateService.findExistingTemplate(
          message,
          siteId,
          config.phoneNumberId,
        );
        if (existing?.templateSid) {
          templateSid = existing.templateSid;
          placeholderMap = existing.placeholderMap ?? campaignTokens;
        } else {
          const created = await WhatsAppTemplateService.createTemplate(
            message,
            config.phoneNumberId,
            config.accessToken,
            siteId,
          );
          if (!created.success || !created.templateSid) {
            return {
              success: false,
              error: `Failed to create WhatsApp template: ${created.error ?? 'unknown error'}`,
            };
          }
          templateSid = created.templateSid;
          placeholderMap = created.placeholderMap ?? campaignTokens;
          // A freshly created template may still be pending WhatsApp approval;
          // delivery worker should re-check before sending.
          templateStatus = 'pending';
        }
      } catch (err: any) {
        return {
          success: false,
          error: `Failed to prepare WhatsApp template: ${err?.message ?? 'unknown error'}`,
        };
      }

      for (let page = 1; page <= totalPages; page++) {
        const { leads } = await getAudiencePageForSending(audience_id, page);
        if (leads.length === 0) continue;

        for (const lead of leads) {
          const leadId = lead.id as string;

          try {
            if (!lead.phone) {
              await updateAudienceLeadStatus(audience_id, leadId, 'skipped', 'No phone number');
              totalSkipped++;
              continue;
            }

            const leadRow = lead as DbLead;
            const built = buildContentVariablesForLead(placeholderMap, leadRow, siteName, mergePolicy);
            if (built.aborted) {
              await updateAudienceLeadStatus(
                audience_id,
                leadId,
                'skipped',
                `Unresolved merge fields: ${built.unresolved.join(', ')}`,
              );
              totalSkipped++;
              continue;
            }

            const conversationData: any = {
              site_id: siteId,
              lead_id: leadId,
              title: subject || `Bulk Message: whatsapp`,
              channel: 'whatsapp',
              custom_data: {
                source: 'sendBulkMessages',
                audience_id,
              },
            };
            if (userId) conversationData.user_id = userId;
            if (agentId) conversationData.agent_id = agentId;

            const { data: conversation, error: convError } = await supabaseAdmin
              .from('conversations')
              .insert([conversationData])
              .select()
              .single();

            if (convError || !conversation) {
              await updateAudienceLeadStatus(
                audience_id,
                leadId,
                'failed',
                convError?.message || 'Failed to create conversation',
              );
              totalFailed++;
              continue;
            }

            const messageData: any = {
              conversation_id: conversation.id,
              // Store the abstract body (with {{1}}, {{2}}, ...) so the delivery worker
              // can reconstruct/log the final text deterministically from ContentVariables.
              content: abstractBody,
              role: 'assistant',
              lead_id: leadId,
              custom_data: {
                status: 'approved',
                channel: 'whatsapp',
                audience_id,
                template_sid: templateSid,
                template_status: templateStatus,
                templated_body: abstractBody,
                placeholder_map: placeholderMap,
                content_variables: built.variables,
              },
            };
            if (agentId) messageData.agent_id = agentId;

            const { error: msgError } = await supabaseAdmin
              .from('messages')
              .insert([messageData]);

            if (msgError) {
              await updateAudienceLeadStatus(audience_id, leadId, 'failed', msgError.message);
              totalFailed++;
            } else {
              await updateAudienceLeadStatus(audience_id, leadId, 'sent');
              totalSent++;
            }
          } catch (err: any) {
            await updateAudienceLeadStatus(
              audience_id,
              leadId,
              'failed',
              err?.message ?? 'Unexpected error',
            );
            totalFailed++;
          }
        }
      }

      const totalRemaining = audience.total_count - totalSent - totalFailed - totalSkipped;
      return {
        success: true,
        audience_id,
        channel,
        template_sid: templateSid,
        template_status: templateStatus,
        placeholder_map: placeholderMap,
        total_sent: totalSent,
        total_failed: totalFailed,
        total_skipped: totalSkipped,
        total_remaining: totalRemaining,
        total_in_audience: audience.total_count,
      };
    }

    // -------------------------------------------------------------------------
    // Email `mail` mode (default): pre-merge body/subject per lead and queue
    // an approved message row for the background email delivery worker.
    // -------------------------------------------------------------------------
    for (let page = 1; page <= totalPages; page++) {
      const { leads } = await getAudiencePageForSending(audience_id, page);
      if (leads.length === 0) continue;

      for (const lead of leads) {
        const leadId = lead.id as string;

        try {
          if (!lead.email) {
            await updateAudienceLeadStatus(audience_id, leadId, 'skipped', 'No email address');
            totalSkipped++;
            continue;
          }

          const leadRow = lead as DbLead;
          const merged = personalizeMergeSubjectAndMessage(
            subject,
            message,
            leadRow,
            siteName,
            mergePolicy,
          );
          if (merged.aborted) {
            await updateAudienceLeadStatus(
              audience_id,
              leadId,
              'skipped',
              `Unresolved merge fields: ${merged.unresolved.join(', ')}`,
            );
            totalSkipped++;
            continue;
          }
          const perLeadMessage = merged.message;
          const perLeadSubject = merged.subject ?? subject;

          // 1. Crear Conversación
          const conversationData: any = {
            site_id: siteId,
            lead_id: leadId,
            title: perLeadSubject || subject || `Bulk Message: email`,
            channel: 'email',
            custom_data: {
              source: 'sendBulkMessages',
              audience_id: audience_id
            }
          };

          if (userId) conversationData.user_id = userId;
          if (agentId) conversationData.agent_id = agentId;

          const { data: conversation, error: convError } = await supabaseAdmin
            .from('conversations')
            .insert([conversationData])
            .select()
            .single();

          if (convError || !conversation) {
            await updateAudienceLeadStatus(audience_id, leadId, 'failed', convError?.message || 'Failed to create conversation');
            totalFailed++;
            continue;
          }

          // 2. Crear Mensaje con estado 'approved'
          const messageData: any = {
            conversation_id: conversation.id,
            content: perLeadMessage,
            role: 'assistant',
            lead_id: leadId,
            custom_data: {
              status: 'approved',
              channel: 'email',
              audience_id: audience_id,
              subject: perLeadSubject,
            }
          };

          // Si hay agente/usuario, lo asignamos. Aunque el rol es assistant, a veces se usa agent_id
          if (agentId) messageData.agent_id = agentId;
          // Note: No seteamos user_id aquí porque el agente es 'assistant'

          const { error: msgError } = await supabaseAdmin
            .from('messages')
            .insert([messageData]);

          if (msgError) {
            await updateAudienceLeadStatus(audience_id, leadId, 'failed', msgError.message);
            totalFailed++;
          } else {
            // El mensaje se guardó correctamente para ser procesado luego
            await updateAudienceLeadStatus(audience_id, leadId, 'sent');
            totalSent++;
          }

        } catch (err: any) {
          await updateAudienceLeadStatus(audience_id, leadId, 'failed', err?.message ?? 'Unexpected error');
          totalFailed++;
        }
      }
    }

    const totalRemaining = audience.total_count - totalSent - totalFailed - totalSkipped;

    return {
      success: true,
      audience_id,
      channel,
      total_sent: totalSent,
      total_failed: totalFailed,
      total_skipped: totalSkipped,
      total_remaining: totalRemaining,
      total_in_audience: audience.total_count,
    };
  };

  return {
    name: 'sendBulkMessages',
    description: `Send a message to all leads in an audience via WhatsApp or email.

Required: audience_id, channel ("whatsapp" or "email"), message.
For email: subject is also required.
Optional: from, content_id (content UUID whose metadata.placeholders.when_unresolved controls unknown merge tokens), placeholder_policy (override), audience_email_mode.

Merge fields — use only double braces: {{lead.name}}, {{lead.first_name}}, {{lead.email}}, {{lead.phone}}, {{lead.position}}, {{lead.company}}, {{lead.notes}}, {{lead.metadata.<key>}}, {{site.name}}. Common aliases (e.g. {{lead.correo}}, {{lead.full_name}}) are normalized. Other syntaxes ([Name], {name}) are not supported.

For email only: audience_email_mode — "mail" (default) or "newsletter".

The tool iterates through every lead in the audience:
- WhatsApp: requires lead.phone (international format). Leads without phone are skipped.
- Email: requires lead.email. Leads without email are skipped.

WhatsApp delivery:
- Creates (or reuses) ONE Twilio Content Template per campaign whose body uses numeric placeholders ({{1}}, {{2}}, ...). Merge tokens in the message are mapped to those placeholders.
- For each lead, queues one conversation + approved message row that stores template_sid and the per-lead content_variables map; a background worker delivers via ContentVariables so a single approved template serves the whole audience.
- Returns template_sid, template_status, and placeholder_map alongside the counters.

Email delivery modes:
- mail (default): queues one conversation plus an approved message per lead (body/subject personalized per lead); a background workflow delivers and tracks. total_sent counts queued handoffs.
- newsletter: sends immediately via sendEmail (open/click tracking), **no** HTML signature appended, no conversation rows. Large audiences may hit server timeouts — prefer smaller batches if needed.

Each lead's send_status is tracked (sent, failed, skipped) so the tool can be re-run safely — already processed leads are not re-queued.

Returns a summary: total_sent, total_failed, total_skipped, total_remaining.

IMPORTANT:
- First create an audience using the "audience" tool, then pass its audience_id here.
- The audience must have status "ready" before sending.
- Review the audience contents with audience(get) before sending to confirm the target list.`,
    parameters: {
      type: 'object',
      properties: {
        audience_id: { type: 'string', description: 'Audience UUID to send messages to.' },
        channel: {
          type: 'string',
          enum: ['whatsapp', 'email'],
          description: 'Delivery channel.',
        },
        message: { type: 'string', description: 'Message text (plain text or HTML for email).' },
        subject: { type: 'string', description: 'Email subject (required when channel is "email").' },
        from: { type: 'string', description: 'Sender display name (optional).' },
        audience_email_mode: {
          type: 'string',
          enum: ['mail', 'newsletter'],
          description: 'Email only. mail (default): queue via conversations. newsletter: send immediately with tracking, no conversations.',
        },
        content_id: {
          type: 'string',
          description:
            'Optional content UUID. When set, metadata.placeholders.when_unresolved (strip_tokens | skip_recipient) controls unknown {{...}} tokens unless placeholder_policy overrides.',
        },
        placeholder_policy: {
          type: 'string',
          enum: ['strip_tokens', 'skip_recipient'],
          description:
            'Override for unresolved merge tokens. strip_tokens: remove unknown tokens. skip_recipient: skip that lead when unknown tokens remain.',
        },
      },
      required: ['audience_id', 'channel', 'message'],
    },
    execute,
  };
}
