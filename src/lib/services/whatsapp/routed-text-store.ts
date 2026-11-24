import { supabaseAdmin } from '@/lib/database/supabase-client';
import { loadExactDeliveryContext } from '@/lib/messaging/exact-delivery-context';
import { fetchSiteNameForMerge, personalizeMergeTemplate } from '@/lib/messaging/lead-merge-fields';
import { matchesZavuThread } from '@/lib/services/channels/zavu-thread-scope';
import { inboundRecipient, verifiedTextInbound, type Inbound } from './routed-text-policy';
import { routedRecipient, RoutedTextRecipientError } from './routed-text-identity';

export interface RoutedIdentity { site_id: string; conversation_id: string; message_id: string }
type Data = Record<string, any>;
export interface RoutedContext {
  role: string; content: string; text: string; recipient: string; metadata: Data; conversation: Data; inbound: Inbound[];
}

/** visitors has no site_id. Scope every read through the already site-checked
 * lead, a visitor session in this site, or the visitor's site-owned segment. */
async function scopedVisitorContact(siteId: string, visitorId: string, leadId?: string) {
  const columns = 'lead_id,custom_data';
  if (leadId) {
    const { data, error } = await supabaseAdmin.from('visitors').select(columns)
      .eq('id', visitorId).eq('lead_id', leadId).maybeSingle();
    if (error) throw new Error('WhatsApp visitor unavailable');
    if (data) return data;
  }
  // Empty embeds check membership without loading all historical sessions.
  for (const relation of ['visitor_sessions', 'segments'] as const) {
    const { data, error } = await supabaseAdmin.from('visitors').select(`${columns},${relation}!inner()`)
      .eq('id', visitorId).eq(`${relation}.site_id`, siteId).maybeSingle();
    if (error) throw new Error('WhatsApp visitor unavailable');
    if (data) return data as unknown as { lead_id: string | null; custom_data: Data | null };
  }
  throw new Error('WhatsApp visitor unavailable');
}

/** This endpoint does not accept content, sender, or destination from the caller. */
export async function loadRoutedText(id: RoutedIdentity): Promise<RoutedContext> {
  const ctx = await loadExactDeliveryContext({ ...id, channel: 'whatsapp' });
  const m = ctx.message, c = ctx.conversation, d = ctx.customData;
  if (!c || !m || !['assistant', 'team_member'].includes(m.role) || !d || !m.custom_data
    || typeof m.content !== 'string' || !m.content.trim() || !matchesZavuThread(c.channel ?? c.custom_data?.channel ?? c.custom_data?.source, c.custom_data, 'whatsapp')
    || (d.channel != null && d.channel !== 'whatsapp') || (d.response_format != null && d.response_format !== 'text')
    || (d.message_type != null && d.message_type !== 'text') || d.media_url || d.media_urls || d.attachments || d.mime_type
    || d.reply_to_message_id || d.origin_message_id || d.outreach_activity !== undefined || d.internal || d.agent_disabled || d.response_skipped) {
    throw new Error('Saved message is not a routable WhatsApp text');
  }
  // Do not infer uniqueness or choose a recipient from a truncated history.
  const { data: inbound, error } = await supabaseAdmin.from('messages').select('id,lead_id,visitor_id,custom_data,created_at,conversations!inner(site_id)')
    .eq('conversation_id', id.conversation_id).eq('conversations.site_id', id.site_id).in('role', ['user', 'visitor'])
    .order('created_at', { ascending: false }).limit(1000);
  if (error || !Array.isArray(inbound) || inbound.length >= 1000) throw new Error('WhatsApp inbound routing history unavailable');
  let recipient: string;
  try {
    if ('whatsapp_support_inbound_id' in d) {
      const source = inbound.filter(row => row.id === d.whatsapp_support_inbound_id);
      if (m.role !== 'assistant' || !d.whatsapp_support_inbound_id || source.length !== 1 || verifiedTextInbound(source[0])?.provider !== 'twilio') {
        throw new Error('Saved WhatsApp support reply lost its original inbound');
      }
    }
    for (const key of ['lead_id', 'visitor_id'] as const) {
      const ids = new Set([c[key], m[key], ...inbound.map(row => row[key])].filter(v => v != null));
      if (ids.size > 1) throw new RoutedTextRecipientError();
    }
    const visitorId = c.visitor_id || m.visitor_id;
    const visitor = visitorId ? await scopedVisitorContact(id.site_id, visitorId, ctx.lead?.id) : undefined;
    if (ctx.lead?.id && visitor?.lead_id && visitor.lead_id !== ctx.lead.id) throw new RoutedTextRecipientError();
    recipient = routedRecipient(inboundRecipient(inbound), [visitor?.custom_data?.whatsapp_phone, ctx.lead?.phone, c.custom_data?.whatsapp_phone],
      [d.whatsapp_phone, d.recipient, d.to, d.phone_number, c.custom_data?.zavu_from,
      ...inbound.flatMap(row => [row.custom_data?.whatsapp_phone, row.custom_data?.from_number,
        row.custom_data?.from, row.custom_data?.zavu_from])]);
  } catch (err) {
    if (err instanceof RoutedTextRecipientError) err.snapshot = { role: m.role, content: m.content, metadata: d };
    throw err;
  }
  let text: string = m.content;
  if (text.includes('{{')) {
    const merged = personalizeMergeTemplate(text, ctx.lead || {}, await fetchSiteNameForMerge(id.site_id), 'abort_if_unresolved');
    if (merged.aborted || !merged.text.trim() || /\{\{|\}\}/.test(merged.text)) throw new Error('WhatsApp text contains unresolved fields');
    text = merged.text;
  }
  return { role: m.role, content: m.content, text, recipient, metadata: d, conversation: c.custom_data || {}, inbound };
}

/** One owner before any external side effect. Never change routes after a lost CAS. */
export async function writeRoutedText(id: RoutedIdentity, ctx: Pick<RoutedContext, 'role' | 'content'>, previous: Data, next: Data) {
  const { data, error } = await supabaseAdmin.from('messages').update({ custom_data: next })
    .eq('id', id.message_id).eq('conversation_id', id.conversation_id).eq('role', ctx.role).eq('content', ctx.content)
    .eq('custom_data', JSON.stringify(previous)).select('id').maybeSingle();
  if (error || !data) throw new Error('WhatsApp receipt ownership changed');
}