import { supabaseAdmin } from '@/lib/database/supabase-client';
import { getSiteLicensedResources, isLicensedChannelConnection } from '@/lib/billing/licensed-resources';

export class AudioRoutingError extends Error {
  readonly status = 409;
  constructor(message = 'Audio sender is unavailable or ambiguous') { super(message); }
}

export type AudioRouting =
  | { kind: 'zavu'; connectionId: string; senderId: string }
  | { kind: 'legacy-whatsapp'; connectionId: 'legacy:whatsapp' };

type RoutingInput = {
  siteId: string;
  conversationId: string;
  channel: string;
  /** Saved message binding, never an untrusted request hint. */
  connectionId?: unknown;
  /** Only the dedicated WhatsApp adapter may enable the legacy Twilio route. */
  allowLegacyWhatsApp?: boolean;
};

function binding(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value || value.trim() !== value || /[\x00-\x1f\x7f]/.test(value)) {
    throw new AudioRoutingError('Saved audio connection is invalid');
  }
  return value;
}

/**
 * Resolve only server-owned routing: message > conversation > unique inbound
 * history > sole configured sender. Explicit stale bindings never fall through.
 * No provider credentials leave this helper, and generic Zavu never gets a
 * reserved legacy connection identifier.
 */
export async function resolveAudioRouting(input: RoutingInput): Promise<AudioRouting> {
  if (!input.siteId || !input.conversationId || !['whatsapp', 'telegram', 'messenger'].includes(input.channel)) {
    throw new AudioRoutingError('Audio conversation routing is required');
  }
  const { data: conversation, error } = await supabaseAdmin.from('conversations')
    .select('id, channel, custom_data').eq('id', input.conversationId).eq('site_id', input.siteId).maybeSingle();
  const channel = conversation?.channel || conversation?.custom_data?.channel || conversation?.custom_data?.source;
  if (error || !conversation || channel !== input.channel) {
    throw new AudioRoutingError('Audio conversation routing is unavailable');
  }
  let selected = binding(input.connectionId);
  if (selected === undefined) selected = binding(conversation.custom_data?.connection_id);
  if (selected === undefined) {
    // Zavu support persists account scope on the inbound message, not necessarily
    // on its conversation. Never inspect another conversation/site or an outbound
    // row, nor silently use only the latest account in a mixed-account history.
    const { data: inbound, error: historyError } = await supabaseAdmin.from('messages')
      .select('custom_data, conversations!inner(site_id)')
      .eq('conversation_id', input.conversationId).eq('conversations.site_id', input.siteId)
      .eq('role', 'user').order('created_at', { ascending: false }).limit(1000);
    // A full page may have been truncated by PostgREST. Fail closed rather than
    // claiming uniqueness across a partial history.
    if (historyError || !Array.isArray(inbound) || inbound.length >= 1000) {
      throw new AudioRoutingError('Audio inbound routing history is unavailable');
    }
    const ids = new Set(inbound.map(row => binding(row.custom_data?.connection_id)).filter(id => id !== undefined));
    if (ids.size > 1) throw new AudioRoutingError('Audio inbound routing is ambiguous');
    selected = ids.values().next().value;
  }

  const { channels } = await getSiteLicensedResources(input.siteId);
  const legacyAllowed = input.allowLegacyWhatsApp === true && input.channel === 'whatsapp'
    && conversation.custom_data?.channel_delivery !== true;
  if (selected?.startsWith('legacy:') || (selected === undefined && legacyAllowed)) {
    if (!legacyAllowed || (selected !== undefined && selected !== 'legacy:whatsapp')) {
      throw new AudioRoutingError('Legacy WhatsApp routing requires its dedicated adapter');
    }
    const legacy = channels.whatsapp;
    if (!legacy || !['active', 'connected', 'synced'].includes(legacy.status) || legacy.enabled === false
      || legacy.license_suspended === true || legacy._license?.manually_disabled === true
      || typeof legacy.account_sid !== 'string' || !legacy.account_sid.trim()
      || typeof (legacy.existingNumber || legacy.from_number) !== 'string'
      || !(legacy.existingNumber || legacy.from_number).trim()) {
      throw new AudioRoutingError('Legacy WhatsApp sender is unavailable');
    }
    return { kind: 'legacy-whatsapp', connectionId: 'legacy:whatsapp' };
  }

  const configured = channels.connections.filter(row => selected !== undefined
    ? row.id === selected : row.type === input.channel);
  const usable = configured.filter(row => isLicensedChannelConnection(input.channel, row)
    && typeof row.id === 'string' && !!row.id.trim() && !row.id.startsWith('legacy:')
    && typeof row.zavu_sender_id === 'string' && !!row.zavu_sender_id.trim());
  // Reject duplicate IDs and stale explicit bindings even if another sender works.
  if (usable.length !== 1 || (selected !== undefined && configured.length !== 1)
    || channels.connections.filter(row => row.id === usable[0]?.id).length !== 1) {
    throw new AudioRoutingError();
  }
  return { kind: 'zavu', connectionId: usable[0].id, senderId: usable[0].zavu_sender_id };
}