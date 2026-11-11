import { supabaseAdmin } from '@/lib/database/supabase-client';

/** Canonicalize representation only; never guess country codes or match suffixes. */
export function normalizeWhatsAppAutomationRecipient(value: unknown): string {
  if (typeof value !== 'string' || !/^(whatsapp:)?\+?[1-9]\d{6,14}$/.test(value)) {
    throw new Error('CUSTOMER_SUPPORT_SNOOZE_CONTACT_INVALID');
  }
  return `+${value.replace(/^whatsapp:/, '').replace(/^\+/, '')}`;
}

/** Bind the saved inbound and consume pending human events before model/context work.
 * The RPC shares a contact lock with human registration. Once bound, subsequent
 * human events update the conversation immediately, including during generation.
 * Missing migration/unavailable persistence must fail closed, never become no pause.
 */
export async function reconcileConversationHumanEvents(input: {
  siteId: string;
  conversationId: string;
  metadata: Record<string, unknown>;
}): Promise<void> {
  const { connection_id: connection, zavu_sender_id: sender, zavu_from: from } = input.metadata;
  if (!input.siteId || !input.conversationId || typeof connection !== 'string' || !connection
      || typeof sender !== 'string' || !sender) {
    throw new Error('CUSTOMER_SUPPORT_SNOOZE_CONTACT_INVALID');
  }
  const db = supabaseAdmin.schema(process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA
    || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA || 'public');
  const { data, error } = await db.rpc('reconcile_conversation_human_events', {
    p_site_id: input.siteId, p_connection_id: connection, p_sender_id: sender,
    p_recipient: normalizeWhatsAppAutomationRecipient(from), p_conversation_id: input.conversationId,
  });
  if (error || data?.state !== 'reconciled' || data.conversation_id !== input.conversationId) {
    throw new Error('CUSTOMER_SUPPORT_SNOOZE_RECONCILIATION_FAILED');
  }
}