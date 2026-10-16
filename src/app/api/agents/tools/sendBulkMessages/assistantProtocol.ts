import { supabaseAdmin } from '@/lib/database/supabase-client';
import { sanitizeToolContextText, type ToolExecutionContext } from '@/lib/services/tool-execution-context';
import {
  getAudienceById,
} from '@/lib/database/audience-db';
import type { DbLead } from '@/lib/database/lead-db';
import {
  buildContentVariablesForLead,
  extractMergeTokens,
  fetchSiteNameForMerge,
  personalizeMergeSubjectAndMessage,
  placeholderPolicyToMergePolicy,
} from '@/lib/messaging/lead-merge-fields';
import {
  SEND_BULK_MESSAGES_DESCRIPTION,
  SEND_BULK_MESSAGES_PARAMETERS,
  type SendBulkMessagesToolParams,
} from './definition';
import {
  findActiveSalesAgent,
  resolveNumberedTemplate,
  resolvePlaceholderPolicy,
} from './support';
import {
  prepareVoiceRecipient,
} from './voice-context';

import { executeBulkRoutes, recipientContextForBulk, type BulkExecutionIO } from './routing';
import { getExactWhatsAppConfig, sendExactDelivery } from '@/lib/messaging/exact-delivery';
import { canonicalExactTemplateBody } from '@/lib/messaging/exact-template-body';
import { prepareExactWhatsAppTemplate } from './exact-whatsapp-template';

export function sendBulkMessagesTool(siteId: string) {
  const executeSingle = async (args: SendBulkMessagesToolParams, executionContext: ToolExecutionContext | undefined, io: BulkExecutionIO) => {
    const {
      audience_id,
      channel,
      connection_id,
      message,
      subject,
      from,
      content_id: contentIdArg,
      placeholder_policy,
      voice_mode = 'tts',
      objective,
      additional_context,
    } = args;
    const audience_email_mode = args.audience_email_mode ?? 'mail';
    const recipientContext = recipientContextForBulk(siteId, args, executionContext);

    if (!audience_id) return { success: false, error: 'Missing required field: audience_id' };
    if (!channel) return { success: false, error: 'Missing required field: channel' };
    if (!message) return { success: false, error: 'Missing required field: message' };
    if (channel === 'email' && !subject) {
      return { success: false, error: 'Missing required field for email: subject' };
    }
    const audience = await getAudienceById(audience_id);
    if (!audience) return { success: false, error: 'Audience not found' };
    if (audience.site_id !== siteId) return { success: false, error: 'Audience does not belong to this site' };
    if (audience.status !== 'ready') {
      return { success: false, error: `Audience is not ready (status: ${audience.status})` };
    }

    const placeholderPolicyResolved = await resolvePlaceholderPolicy(contentIdArg, placeholder_policy);

    if (channel === 'email' && audience_email_mode === 'newsletter') {
      const agent = await findActiveSalesAgent(siteId);
      const agentId = agent?.agentId ?? undefined;

      const totalPages = Math.ceil(audience.total_count / audience.page_size);
      let totalSent = 0;
      let totalFailed = 0;
      let totalSkipped = 0;

      for (let page = 1; page <= totalPages; page++) {
        const { leads } = await io.page(audience_id, page);
        if (leads.length === 0) continue;

        for (const lead of leads) {
          const leadRow = lead as unknown as DbLead;
          const leadId = leadRow.id;

          try {
            if (!leadRow.email) {
              await io.status(audience_id, leadId, 'skipped', 'No email address');
              totalSkipped++;
              continue;
            }

            const result = await sendExactDelivery({
              channel: 'email', connection_id: connection_id!, to: leadRow.email,
              site_id: siteId,
              email: leadRow.email,
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
              await io.status(audience_id, leadId, 'sent');
              totalSent++;
            } else {
              const errMsg = result.error?.message
                ?? (result.status === 'skipped' ? 'Email send skipped' : 'Email send failed');
              const isUnresolved = result.error?.code === 'PLACEHOLDERS_UNRESOLVED';
              await io.status(
                audience_id,
                leadId,
                isUnresolved ? 'skipped' : 'failed',
                errMsg,
              );
              if (isUnresolved) totalSkipped++;
              else totalFailed++;
            }
          } catch (err: any) {
            await io.status(
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

    const agent = await findActiveSalesAgent(siteId);
    const agentId = agent?.agentId || null;
    const userId = agent?.userId || null;

    // WhatsApp/Telegram/SMS/Voice path: create/reuse ONE template with numeric placeholders and
    // queue per-lead ContentVariables. The template body is kept abstract
    // (e.g. "Hi {{1}}, ..."); personalization happens via Twilio variables at
    // delivery time (for whatsapp), so a single approved template serves the whole campaign.
    if (channel === 'whatsapp' || channel === 'telegram' || channel === 'sms' || channel === 'voice') {
      const { templated, tokens: campaignTokens } = extractMergeTokens(message);
      let abstractBody = channel === 'whatsapp' && connection_id?.startsWith('legacy:') ? canonicalExactTemplateBody(templated) : templated;

      let templateSid: string | undefined;
      let placeholderMap: string[] = campaignTokens;
      let templateStatus: 'approved' | 'pending' = 'approved';

      // Template logic is only required for WhatsApp, but we keep the structure
      // for other channels that might use standard template engines if needed.
      if (channel === 'whatsapp' && connection_id?.startsWith('legacy:')) {
        try {
          const config = await getExactWhatsAppConfig(siteId, connection_id);
          if (!config) throw new Error('Selected WhatsApp account does not use Twilio templates.');
          const prepared = await prepareExactWhatsAppTemplate({
            message, siteId, accountSid: config.phoneNumberId, accessToken: config.accessToken,
          });
          templateSid = prepared.templateSid;
          abstractBody = prepared.templatedBody;
          placeholderMap = prepared.placeholderMap;
          templateStatus = prepared.templateStatus;
        } catch (err: any) {
          return {
            success: false,
            error: `Failed to prepare WhatsApp template: ${err?.message ?? 'unknown error'}`,
          };
        }
      }

      for (let page = 1; page <= totalPages; page++) {
        const { leads } = await io.page(audience_id, page);
        if (leads.length === 0) continue;

        for (const lead of leads) {
          const leadId = lead.id as string;

          try {
            if (['whatsapp', 'sms', 'voice'].includes(channel) && !lead.phone) {
              await io.status(audience_id, leadId, 'skipped', 'No phone number');
              totalSkipped++;
              continue;
            }

            const leadRow = lead as unknown as DbLead;
            const built = buildContentVariablesForLead(placeholderMap, leadRow, siteName, mergePolicy);
            if (built.aborted) {
              await io.status(
                audience_id,
                leadId,
                'skipped',
                `Unresolved merge fields: ${built.unresolved.join(', ')}`,
              );
              totalSkipped++;
              continue;
            }
            const voiceRecipient = prepareVoiceRecipient({
              channel,
              voiceMode: voice_mode,
              lead: leadRow,
              siteName,
              policy: mergePolicy,
              objective,
              additionalContext: additional_context,
            });
            if (voiceRecipient.skipReason) {
              await io.status(
                audience_id,
                leadId,
                'skipped',
                voiceRecipient.skipReason,
              );
              totalSkipped++;
              continue;
            }
            // Legacy fields remain readable by existing workers, but must not
            // retain an unredacted copy next to the sanitized envelope.
            const voiceContextData: Record<string, string> = {};
            const safeObjective = sanitizeToolContextText(voiceRecipient.customData.voice_objective, 500);
            const safeBackground = sanitizeToolContextText(voiceRecipient.customData.voice_additional_context, 4_000);
            if (safeObjective) voiceContextData.voice_objective = safeObjective;
            if (safeBackground) voiceContextData.voice_additional_context = safeBackground;

            const conversationData: any = {
              site_id: siteId,
              lead_id: leadId,
              title: subject || `Bulk Message: ${channel}`,
              channel: channel,
              custom_data: {
                connection_id,
              source: 'sendBulkMessages',
                audience_id,
                ...(channel === 'voice' ? { voice_mode } : {}),
                ...voiceContextData,
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
              await io.status(
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
              content: channel === 'whatsapp' && connection_id?.startsWith('legacy:')
                ? abstractBody
                : resolveNumberedTemplate(abstractBody, built.variables),
              role: 'assistant',
              lead_id: leadId,
              custom_data: {
                status: 'accepted',
                channel: channel,
                connection_id,
                audience_id,
                ...(channel === 'voice' ? { voice_mode } : {}),
                ...voiceContextData,
                ...(templateSid ? { template_sid: templateSid } : {}),
                ...(templateStatus ? { template_status: templateStatus } : {}),
                templated_body: abstractBody,
                placeholder_map: placeholderMap,
                content_variables: built.variables,
                ...recipientContext(voiceContextData),
              },
            };
            if (agentId) messageData.agent_id = agentId;

            const { error: msgError } = await supabaseAdmin
              .from('messages')
              .insert([messageData]);

            if (msgError) {
              await io.status(audience_id, leadId, 'failed', msgError.message);
              totalFailed++;
            } else {
              await io.status(audience_id, leadId, 'sent');
              totalSent++;
            }
          } catch (err: any) {
            await io.status(
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

    // Email `mail` mode (default): pre-merge body/subject per lead and queue
    // an accepted message row for the background email delivery worker.
    for (let page = 1; page <= totalPages; page++) {
      const { leads } = await io.page(audience_id, page);
      if (leads.length === 0) continue;

      for (const lead of leads) {
        const leadId = lead.id as string;

        try {
          if (!lead.email) {
            await io.status(audience_id, leadId, 'skipped', 'No email address');
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
            await io.status(
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
              connection_id,
              source: 'sendBulkMessages',
              audience_id: audience_id,
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
            await io.status(audience_id, leadId, 'failed', convError?.message || 'Failed to create conversation');
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
              connection_id,
              audience_id: audience_id,
              subject: perLeadSubject,
              ...recipientContext(),
            }
          };

          // Si hay agente/usuario, lo asignamos. Aunque el rol es assistant, a veces se usa agent_id
          if (agentId) messageData.agent_id = agentId;
          // Note: No seteamos user_id aquí porque el agente es 'assistant'

          const { error: msgError } = await supabaseAdmin
            .from('messages')
            .insert([messageData]);

          if (msgError) {
            await io.status(audience_id, leadId, 'failed', msgError.message);
            totalFailed++;
          } else {
            // El mensaje se guardó correctamente para ser procesado luego
            await io.status(audience_id, leadId, 'sent');
            totalSent++;
          }

        } catch (err: any) {
          await io.status(audience_id, leadId, 'failed', err?.message ?? 'Unexpected error');
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
    execute: (args: SendBulkMessagesToolParams, context?: ToolExecutionContext) => executeBulkRoutes(siteId, args, context, executeSingle),
  };
}
