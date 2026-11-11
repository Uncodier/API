import { supabaseAdmin } from '@/lib/database/supabase-client';

export interface AutomationSendIdentity {
  site_id: string;
  conversation_id?: string;
  message_id?: string;
  message?: string;
}
export type AutomationSkipReason = 'agent_snoozed' | 'stale_automatic_reply';
export class AutomationSendSuppressed extends Error {
  constructor(readonly reason: AutomationSkipReason) { super(reason); }
}
export function automationSkippedResult(error: AutomationSendSuppressed) {
  return { success: true as const, status: 'skipped' as const, skipped: true as const,
    reason: error.reason, delivered: false as const };
}

/** Re-read immediately before dispatch; caller role/actor flags never authorize a bypass. */
export async function assertAutomationSendAllowed(input: AutomationSendIdentity): Promise<void> {
  if (!input.conversation_id && !input.message_id) return;
  const db = supabaseAdmin.schema(process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA || 'public');
  let conversationId = input.conversation_id;
  if (!conversationId && input.message_id) {
    const { data, error } = await db.from('messages')
      .select('conversation_id, conversations!inner(site_id)').eq('id', input.message_id)
      .eq('conversations.site_id', input.site_id).maybeSingle();
    if (error || !data) throw new Error('Send message scope could not be verified');
    conversationId = data.conversation_id;
  }
  // Non-conversation sends (campaigns/setup) have no conversation snooze to inspect.
  if (!conversationId) return;
  const { data: conversation, error: scopeError } = await db.from('conversations')
    .select('id, automation_paused_until, last_human_reply_at')
    .eq('id', conversationId).eq('site_id', input.site_id).maybeSingle();
  if (scopeError || !conversation) throw new Error('Send conversation scope could not be verified');
  let message: any;
  if (input.message_id) {
    const { data, error } = await db.from('messages').select('id, role, content, created_at, custom_data')
      .eq('id', input.message_id).eq('conversation_id', conversationId).maybeSingle();
    if (error || !data) throw new Error('Send message scope could not be verified');
    message = data;
    if (message.role === 'team_member') {
      if (typeof input.message !== 'string' || message.content !== input.message) {
        throw new Error('Human send requires matching saved content');
      }
      return;
    }
  }
  const metadata = message?.custom_data || {};
  let reason: AutomationSkipReason | undefined;
  if (metadata.automation_skipped === true) {
    reason = metadata.automation_skip_reason === 'stale_automatic_reply' ? 'stale_automatic_reply' : 'agent_snoozed';
  } else if (Date.parse(conversation.automation_paused_until) > Date.now()) {
    reason = 'agent_snoozed';
  } else {
    const generationStart = Date.parse(metadata.automation_started_at);
    const started = Number.isFinite(generationStart) ? generationStart : Date.parse(message?.created_at);
    const human = Date.parse(conversation.last_human_reply_at);
    // Legacy no-message calls have no generation timestamp: enforce the active pause only.
    if (Number.isFinite(human) && Number.isFinite(started) && human >= started) reason = 'stale_automatic_reply';
  }
  if (!reason) return;
  if (message?.role === 'assistant' && metadata.automation_skipped !== true
    && !['sent', 'delivered', 'read'].includes(metadata.status)
    && !metadata.provider_message_id) {
    let update = db.from('messages').update({ custom_data: { ...metadata,
      status: 'skipped', automation_skipped: true, automation_skip_reason: reason,
      automation_skipped_at: new Date().toISOString(),
    } }).eq('id', input.message_id!).eq('conversation_id', conversationId).eq('role', 'assistant');
    update = message.custom_data == null ? update.is('custom_data', null) : update.eq('custom_data', JSON.stringify(message.custom_data));
    const { data, error } = await update.select('id').maybeSingle();
    if (error || !data) throw new Error('Could not persist suppressed send');
  }
  throw new AutomationSendSuppressed(reason);
}