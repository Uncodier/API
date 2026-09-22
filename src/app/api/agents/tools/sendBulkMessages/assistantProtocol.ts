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
import {
  SEND_BULK_MESSAGES_DESCRIPTION,
  SEND_BULK_MESSAGES_PARAMETERS,
} from './definition';
import {
  findActiveSalesAgent,
  resolvePlaceholderPolicy,
} from './support';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SendBulkMessagesToolParams {
  audience_id: string;
  channel: 'whatsapp' | 'email' | 'telegram' | 'sms' | 'voice';
  message: string;
  subject?: string;
  from?: string;
  /** Email only: `mail` (default) queues via conversations; `newsletter` sends immediately with tracking, no conversations. */
  audience_email_mode?: 'mail' | 'newsletter';
  /** Optional content row whose metadata.placeholders.when_unresolved controls unknown {{...}} tokens. */
  content_id?: string;
  /** Override policy when content_id is absent or has no placeholders config. Default: strip_tokens. */
  placeholder_policy?: ContentPlaceholderPolicy;
  /** Voice only: one-way TTS (default) or a two-way Zavu agent call. */
  voice_mode?: 'tts' | 'agent_call';
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function sendBulkMessagesTool(siteId: string) {
  const execute = async (args: SendBulkMessagesToolParams) => {
    const {
      audience_id,
      channel,
      message,
      subject,
      from,
      content_id: contentIdArg,
      placeholder_policy,
      voice_mode = 'tts',
    } = args;
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
    if (voice_mode === 'agent_call' && channel !== 'voice') {
      return {
        success: false,
        error: 'voice_mode "agent_call" is only valid when channel is "voice".',
      };
    }
    if (voice_mode === 'agent_call' && message.length > 1_000) {
      return {
        success: false,
        error: 'Voice agent call greeting must not exceed 1000 characters.',
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
              subject: subject || '',
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
    // WhatsApp/Telegram/SMS/Voice path: create/reuse ONE template with numeric placeholders and
    // queue per-lead ContentVariables. The template body is kept abstract
    // (e.g. "Hi {{1}}, ..."); personalization happens via Twilio variables at
    // delivery time (for whatsapp), so a single approved template serves the whole campaign.
    // -------------------------------------------------------------------------
    if (channel === 'whatsapp' || channel === 'telegram' || channel === 'sms' || channel === 'voice') {
      const { templated: abstractBody, tokens: campaignTokens } = extractMergeTokens(message);

      let templateSid: string | undefined;
      let placeholderMap: string[] = campaignTokens;
      let templateStatus: 'approved' | 'pending' = 'approved';

      // Template logic is only required for WhatsApp, but we keep the structure
      // for other channels that might use standard template engines if needed.
      if (channel === 'whatsapp') {
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
      }

      for (let page = 1; page <= totalPages; page++) {
        const { leads } = await getAudiencePageForSending(audience_id, page);
        if (leads.length === 0) continue;

        for (const lead of leads) {
          const leadId = lead.id as string;

          try {
            // For whatsapp/sms/voice we need a phone number
            if (['whatsapp', 'sms', 'voice'].includes(channel) && !lead.phone) {
              await updateAudienceLeadStatus(audience_id, leadId, 'skipped', 'No phone number');
              totalSkipped++;
              continue;
            }

            const leadRow = lead as unknown as DbLead;
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
              title: subject || `Bulk Message: ${channel}`,
              channel: channel,
              custom_data: {
                source: 'sendBulkMessages',
                audience_id,
                ...(channel === 'voice' ? { voice_mode } : {}),
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
                status: 'accepted',
                channel: channel,
                audience_id,
                ...(channel === 'voice' ? { voice_mode } : {}),
                ...(templateSid ? { template_sid: templateSid } : {}),
                ...(templateStatus ? { template_status: templateStatus } : {}),
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
    // an accepted message row for the background email delivery worker.
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

          const leadRow = lead as unknown as DbLead;
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

          // 2. Crear Mensaje con estado 'accepted'
          const messageData: any = {
            conversation_id: conversation.id,
            content: perLeadMessage,
            role: 'assistant',
            lead_id: leadId,
            custom_data: {
              status: 'accepted',
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
    description: SEND_BULK_MESSAGES_DESCRIPTION,
    parameters: SEND_BULK_MESSAGES_PARAMETERS,
    execute,
  };
}
