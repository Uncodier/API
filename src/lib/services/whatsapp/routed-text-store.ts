import { supabaseAdmin } from '@/lib/database/supabase-client';
import { loadExactDeliveryContext } from '@/lib/messaging/exact-delivery-context';
import { fetchSiteNameForMerge, personalizeMergeTemplate } from '@/lib/messaging/lead-merge-fields';
import { matchesZavuThread } from '@/lib/services/channels/zavu-thread-scope';
import { inboundRecipient, verifiedTextInbound, type Inbound } from './routed-text-policy';
import { providerPhone, routedRecipient, RoutedTextRecipientError } from './routed-text-identity';
import { isLegacyTwilioTurn, verifyLegacyTwilioTurn } from './routed-text-legacy-inbound';
import { zavuInboundBindingHash } from '@/lib/services/zavu/inbound-claim';

export interface RoutedIdentity { site_id: string; conversation_id: string; message_id: string }
type Data = Record<string, any>;
type LeadPhoneRepair = { leadId: string; previous: string | null; updatedAt: string; voiceConsent: string };
const contactPhone = (value: unknown) => providerPhone(typeof value === 'string' ? value.replace(/[ ().-]/g, '') : value);
export interface RoutedContext {
  role: string; content: string; text: string; recipient: string; metadata: Data; conversation: Data; inbound: Inbound[];
  leadPhoneRepair?: LeadPhoneRepair;
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
  const { data: history, error } = await supabaseAdmin.from('messages').select('id,lead_id,visitor_id,custom_data,created_at,conversations!inner(site_id)')
    .eq('conversation_id', id.conversation_id).eq('conversations.site_id', id.site_id).in('role', ['user', 'visitor'])
    .order('created_at', { ascending: false }).limit(1000);
  if (error || !Array.isArray(history) || history.length >= 1000) throw new Error('WhatsApp inbound routing history unavailable');
  const inbound: Inbound[] = [...history];
  let recipient: string;
  let leadPhoneRepair: LeadPhoneRepair | undefined;
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
    const manual = m.role === 'team_member' && d.dispatch_owner === 'chat_intervention' && c.channel === 'whatsapp';
    const lead = c.lead_id === ctx.lead?.id ? ctx.lead : undefined;
    let verified = inboundRecipient(inbound);
    let provenForRepair = false;
    const latest = inbound[0];
    // A provider lookup is only needed for the older manual reply path. Scope
    // the content read again to the same conversation and the inbound role.
    if (!verified && manual && lead && latest?.id && latest.lead_id === lead.id && latest.custom_data?.source === 'whatsapp') {
      const { data: legacy, error: lookupError } = await supabaseAdmin.from('messages')
        .select('content').eq('id', latest.id).eq('conversation_id', id.conversation_id).eq('lead_id', lead.id)
        .eq('custom_data', JSON.stringify(latest.custom_data)).in('role', ['user', 'visitor']).maybeSingle();
      if (lookupError) throw new Error('WhatsApp inbound history unavailable');
      const candidate = { ...latest, content: legacy?.content };
      if (isLegacyTwilioTurn(candidate)) {
        const proof = await verifyLegacyTwilioTurn(id.site_id, candidate);
        if (proof) {
          inbound[0] = proof;
          verified = inboundRecipient(inbound);
          provenForRepair = true;
        }
      }
    }
    const latestIdentity = inbound[0] && verifiedTextInbound(inbound[0]);
    const needsRepair = manual && lead && latest?.lead_id === lead.id && verified && latestIdentity?.recipient === verified
      && contactPhone(lead.phone) !== verified && Date.parse(lead.updated_at) <= Date.parse(latestIdentity.receivedAt);
    if (needsRepair && latestIdentity?.provider === 'zavu' && latestIdentity.connectionId && latestIdentity.zavuSender) {
      const origin = latest.custom_data?.origin_message_id;
      const from = latest.custom_data?.zavu_from;
      if (typeof origin === 'string' && origin.trim() && typeof from === 'string') {
        const hash = zavuInboundBindingHash({ siteId: id.site_id, channel: 'whatsapp',
          connectionId: latestIdentity.connectionId, senderId: latestIdentity.zavuSender }, origin, from);
        const { data, error } = await supabaseAdmin.rpc('has_signed_zavu_inbound_binding', { p_binding_hash: hash });
        if (error) throw new Error('WhatsApp inbound verification unavailable');
        provenForRepair = data === true;
      }
    }
    const canRepair = needsRepair && provenForRepair;
    recipient = routedRecipient(verified,
      [visitor?.custom_data?.whatsapp_phone, canRepair ? undefined : ctx.lead?.phone, c.custom_data?.whatsapp_phone],
      [d.whatsapp_phone, d.recipient, d.to, d.phone_number, c.custom_data?.zavu_from,
      ...inbound.flatMap(row => [row.custom_data?.whatsapp_phone, row.custom_data?.from_number,
        row.custom_data?.from, row.custom_data?.zavu_from])]);
    if (canRepair) {
      leadPhoneRepair = { leadId: lead.id, previous: lead.phone ?? null, updatedAt: lead.updated_at,
        voiceConsent: lead.voice_call_consent_status };
    }
  } catch (err) {
    if (err instanceof RoutedTextRecipientError) err.snapshot = { role: m.role, content: m.content, metadata: d };
    throw err;
  }
  let text: string = m.content;
  if (text.includes('{{')) {
    const lead = leadPhoneRepair ? { ...ctx.lead, phone: recipient } : ctx.lead;
    const merged = personalizeMergeTemplate(text, lead || {}, await fetchSiteNameForMerge(id.site_id), 'abort_if_unresolved');
    if (merged.aborted || !merged.text.trim() || /\{\{|\}\}/.test(merged.text)) throw new Error('WhatsApp text contains unresolved fields');
    text = merged.text;
  }
  return { role: m.role, content: m.content, text, recipient, metadata: d, conversation: c.custom_data || {}, inbound, leadPhoneRepair };
}

export async function reconcileRoutedLeadPhone(id: RoutedIdentity, ctx: RoutedContext) {
  const repair = ctx.leadPhoneRepair;
  if (!repair) return;
  const update = supabaseAdmin.from('leads').update({ phone: ctx.recipient,
    ...(repair.voiceConsent === 'granted' ? { voice_call_consent_status: 'unknown', voice_call_consent_at: null } : {}),
    updated_at: new Date().toISOString(),
  }).eq('id', repair.leadId).eq('site_id', id.site_id).eq('updated_at', repair.updatedAt)
    .eq('voice_call_consent_status', repair.voiceConsent);
  const { data, error } = await (repair.previous === null ? update.is('phone', null) : update.eq('phone', repair.previous))
    .select('id').maybeSingle();
  if (error || !data) throw new Error('WhatsApp lead phone changed during verification');
}

/** One owner before any external side effect. Never change routes after a lost CAS. */
export async function writeRoutedText(id: RoutedIdentity, ctx: Pick<RoutedContext, 'role' | 'content'>, previous: Data, next: Data) {
  const { data, error } = await supabaseAdmin.from('messages').update({ custom_data: next })
    .eq('id', id.message_id).eq('conversation_id', id.conversation_id).eq('role', ctx.role).eq('content', ctx.content)
    .eq('custom_data', JSON.stringify(previous)).select('id').maybeSingle();
  if (error || !data) throw new Error('WhatsApp receipt ownership changed');
}