import { supabaseAdmin } from '@/lib/database/supabase-client';
import { isTerminalWhatsAppApprovalStatus } from './whatsappTemplateApproval';

export async function getStoredWhatsAppTemplateStatus(
  templateSid: string,
): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from('whatsapp_templates')
    .select('status')
    .eq('template_sid', templateSid)
    .maybeSingle();
  if (error || !data) return null;
  return typeof data.status === 'string' ? data.status : null;
}

export interface HandleRejectedWhatsAppTemplateResult {
  messagesFailed: number;
  conversationsRemoved: number;
}

/**
 * Persist template rejection and fail pending sends for the same Content SID.
 * Outbound-only conversations (no user messages) are removed; CS threads keep history.
 */
export async function handleRejectedWhatsAppTemplate(params: {
  templateSid: string;
  reason?: string;
}): Promise<HandleRejectedWhatsAppTemplateResult> {
  const reason =
    params.reason ||
    'WhatsApp template was rejected, paused, or disabled. Delivery cancelled.';

  await supabaseAdmin
    .from('whatsapp_templates')
    .update({ status: 'rejected', updated_at: new Date().toISOString() })
    .eq('template_sid', params.templateSid);

  const messageIds = await collectPendingMessageIds(params.templateSid);
  let messagesFailed = 0;
  let conversationsRemoved = 0;
  const seenConversations = new Set<string>();

  for (const messageId of messageIds) {
    const { data: messageRows } = await supabaseAdmin
      .from('messages')
      .select('id, conversation_id, custom_data')
      .eq('id', messageId)
      .limit(1);

    const message = messageRows?.[0];
    if (!message) continue;

    const customData =
      message.custom_data && typeof message.custom_data === 'object'
        ? (message.custom_data as Record<string, unknown>)
        : {};
    if (customData.status === 'sent') continue;

    await supabaseAdmin
      .from('messages')
      .update({
        custom_data: {
          ...customData,
          status: 'failed',
          command_status: 'failed',
          template_rejected: true,
          error: reason,
          failed_at: new Date().toISOString(),
        },
        updated_at: new Date().toISOString(),
      })
      .eq('id', messageId);

    await supabaseAdmin
      .from('whatsapp_template_tracking')
      .update({
        status: 'failed',
        error_message: reason,
      })
      .eq('message_id', messageId);

    messagesFailed += 1;

    const conversationId = message.conversation_id as string | null;
    if (!conversationId || seenConversations.has(conversationId)) continue;
    seenConversations.add(conversationId);

    const { data: convoMessages } = await supabaseAdmin
      .from('messages')
      .select('id, role')
      .eq('conversation_id', conversationId);

    const hasInbound = (convoMessages || []).some((m) => m.role === 'user');
    if (hasInbound) continue;

    await supabaseAdmin.from('messages').delete().eq('conversation_id', conversationId);
    const { error: deleteConvoError } = await supabaseAdmin
      .from('conversations')
      .delete()
      .eq('id', conversationId);

    if (deleteConvoError) {
      await supabaseAdmin
        .from('conversations')
        .update({
          status: 'failed',
          updated_at: new Date().toISOString(),
        })
        .eq('id', conversationId);
    }
    conversationsRemoved += 1;
  }

  return { messagesFailed, conversationsRemoved };
}

async function collectPendingMessageIds(templateSid: string): Promise<string[]> {
  const ids = new Set<string>();

  const { data: trackingRows } = await supabaseAdmin
    .from('whatsapp_template_tracking')
    .select('message_id, status')
    .eq('template_sid', templateSid);

  for (const row of trackingRows || []) {
    if (row.status === 'sent' || !row.message_id) continue;
    ids.add(row.message_id as string);
  }

  const { data: messageRows } = await supabaseAdmin
    .from('messages')
    .select('id, custom_data')
    .filter('custom_data->>template_sid', 'eq', templateSid);

  for (const row of messageRows || []) {
    const customData =
      row.custom_data && typeof row.custom_data === 'object'
        ? (row.custom_data as Record<string, unknown>)
        : {};
    if (customData.status === 'sent') continue;
    if (row.id) ids.add(row.id as string);
  }

  return [...ids];
}

export async function isStoredTemplateTerminal(templateSid: string): Promise<boolean> {
  const status = await getStoredWhatsAppTemplateStatus(templateSid);
  return isTerminalWhatsAppApprovalStatus(status);
}
