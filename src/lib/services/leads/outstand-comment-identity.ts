import { supabaseAdmin } from '@/lib/database/supabase-client';

type IdentityStatus = 'available' | 'unavailable' | 'resolve_on_read';

interface CommentIdentity {
  origin: string;
  authorId: string;
  publisherAccountId: string;
  accountScoped: boolean;
  status: IdentityStatus;
  name: string;
  handle: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readable(value: unknown): string {
  const name = text(value);
  return /^(?:social user|unknown|anonymous)$/i.test(name)
    || /^(?:urn:|https?:\/\/)/i.test(name) || /^\d+$/.test(name) ? '' : name;
}

function username(value: unknown): string {
  const handle = text(value).replace(/^@/, '');
  // Explicit usernames can be numeric; only ambiguous author IDs are excluded.
  return new RegExp('^[\\p{L}\\p{N}_.-]+$', 'u').test(handle)
    && !/^(unknown|anonymous)$/i.test(handle) ? handle : '';
}

/** Only the new Outstand contract opts in. Legacy social/DM callers are unchanged. */
export function outstandCommentIdentity(origin: string | undefined, customData: unknown): CommentIdentity | null {
  const data = record(customData);
  if (!origin || !['instagram', 'facebook', 'threads', 'linkedin', 'x', 'youtube'].includes(origin)
    || data.source !== 'comment' || !text(data.outstand_post_id) || !text(data.author_identity_status)) return null;

  const authorId = typeof data.author_id === 'number' && Number.isSafeInteger(data.author_id)
    ? String(data.author_id) : text(data.author_id);
  const status: IdentityStatus = origin === 'linkedin' ? 'resolve_on_read'
    : data.author_identity_status === 'available' ? 'available' : 'unavailable';
  // LinkedIn URNs are global identities. Opaque IDs (including FB/IG IDs) need
  // the publishing account as a namespace, never as the commenter's identity.
  const accountScoped = !(origin === 'linkedin' && /^urn:li:(?:person|organization):[^\s]+$/.test(authorId));
  const handle = status === 'available'
    ? username(data.author_username) || username(data.social_handle) : '';
  return {
    origin, authorId, accountScoped, status,
    publisherAccountId: text(data.publisher_account_id),
    name: status === 'available' ? readable(data.author_name) || handle || 'Social User' : 'Social User',
    handle,
  };
}

/** Errors are not misses: callers must stop processing rather than create again. */
export class OutstandLeadIdentityError extends Error {
  constructor() {
    super('Unable to resolve Outstand commenter identity');
    this.name = 'OutstandLeadIdentityError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function scopedQuery(query: any, siteId: string, identity: CommentIdentity) {
  query = query.eq('site_id', siteId).eq('origin', identity.origin)
    .eq('metadata->>social_author_id', identity.authorId);
  return identity.accountScoped
    ? query.eq('metadata->>social_account_id', identity.publisherAccountId) : query;
}

function hasStableId(identity: CommentIdentity) {
  return Boolean(identity.authorId && (!identity.accountScoped || identity.publisherAccountId));
}

async function lookup(siteId: string, identity: CommentIdentity, byHandle = false, leadId?: string, legacyAccount = false) {
  let query = supabaseAdmin.from('leads').select('id, name, metadata, social_networks');
  if (byHandle) {
    const networkKey = identity.origin === 'x' ? 'twitter' : identity.origin;
    const handle = identity.handle.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    query = query.eq('site_id', siteId).eq('origin', identity.origin)
      // DM IGSIDs are a separate namespace. A coincident handle must not turn
      // a DM lead into a public commenter (possibly under another account).
      .is('metadata->>outstand_dm_participant_id', null)
      .or(`metadata->>social_handle.eq."${handle}",social_networks->>${networkKey}.eq."${handle}"`);
    query = identity.publisherAccountId && !legacyAccount
      ? query.eq('metadata->>social_account_id', identity.publisherAccountId)
      : query.is('metadata->>social_account_id', null);
  } else {
    query = scopedQuery(query, siteId, identity);
  }
  if (leadId) query = query.eq('id', leadId);
  const { data, error } = await query.limit(2);
  // Never arbitrarily choose one of several identities already present.
  if (error || !Array.isArray(data) || data.length > 1) throw new OutstandLeadIdentityError();
  const lead = data[0];
  if (!lead && byHandle && identity.publisherAccountId && !legacyAccount) {
    return lookup(siteId, identity, true, leadId, true);
  }
  if (byHandle && lead) {
    const metadata = record(lead.metadata);
    if (metadata.source === 'outstand_dm') return null;
    // A legacy handle can acquire the new stable reference, but must never
    // reassign a lead already bound to another author or publishing account.
    if ((metadata.social_author_id && identity.authorId && metadata.social_author_id !== identity.authorId)
      || (metadata.social_account_id && metadata.social_account_id !== identity.publisherAccountId)
      || (metadata.social_network && metadata.social_network !== identity.origin)) return null;
  }
  return lead || null;
}

function identityMetadata(identity: CommentIdentity) {
  return {
    source: 'comment',
    social_network: identity.origin,
    ...(hasStableId(identity) ? { social_author_id: identity.authorId } : {}),
    ...(identity.accountScoped && identity.publisherAccountId ? { social_account_id: identity.publisherAccountId } : {}),
    author_identity_status: identity.status,
  };
}

async function refreshIdentity(siteId: string, identity: CommentIdentity, lead: any) {
  const metadata = record(lead.metadata);
  const networks = record(lead.social_networks);
  const networkKey = identity.origin === 'x' ? 'twitter' : identity.origin;
  // A provider refresh cannot overwrite a manual name, even if it used to be
  // generated. Only change names still equal to our own last generated value.
  const canRename = identity.status === 'available' && identity.name !== 'Social User'
    && typeof metadata.outstand_generated_name === 'string'
    && lead.name === metadata.outstand_generated_name;
  const update = {
    metadata: {
      ...metadata,
      ...identityMetadata(identity),
      ...(identity.handle ? { social_handle: identity.handle } : {}),
      ...(canRename ? { outstand_generated_name: identity.name } : {}),
    },
    ...(identity.handle ? { social_networks: { ...networks, [networkKey]: identity.handle } } : {}),
    ...(canRename ? { name: identity.name } : {}),
  };
  let query = supabaseAdmin.from('leads').update(update)
    .eq('site_id', siteId).eq('origin', identity.origin).eq('id', lead.id);
  // Do not overwrite metadata concurrently bound/edited after this lookup.
  query = lead.metadata == null ? query.is('metadata', null) : query.eq('metadata', JSON.stringify(lead.metadata));
  // Protect a name edited after the lookup, not just the snapshot above.
  if (canRename) query = query.eq('name', lead.name);
  const { data, error } = await query.select('id').maybeSingle();
  if (error || !data) throw new OutstandLeadIdentityError();
}

export async function manageOutstandCommentLead(
  siteId: string | undefined,
  identity: CommentIdentity,
  leadId?: string,
): Promise<{ leadId: string | null; isNewLead: boolean; taskId: null }> {
  if (!siteId || (!hasStableId(identity) && !identity.handle && identity.name === 'Social User')) {
    // Neither generic names nor the publishing account identify a commenter.
    return { leadId: null, isNewLead: false, taskId: null };
  }
  try {
    let existing = hasStableId(identity) ? await lookup(siteId, identity, false, leadId) : null;
    if (!existing && identity.handle) existing = await lookup(siteId, identity, true, leadId);
    if (existing) {
      await refreshIdentity(siteId, identity, existing);
      return { leadId: existing.id, isNewLead: false, taskId: null };
    }
    // A supplied lead must match the same site/network/author/account. Do not
    // silently replace it or fall back to a different identifying attribute.
    if (leadId) throw new OutstandLeadIdentityError();

    const { data: site, error: siteError } = await supabaseAdmin.from('sites')
      .select('id, user_id').eq('id', siteId).single();
    if (siteError || site?.id !== siteId || !site.user_id) throw new OutstandLeadIdentityError();

    const networkKey = identity.origin === 'x' ? 'twitter' : identity.origin;
    // Insert the stable reference with the lead, never in a later best-effort
    // merge. LinkedIn names, usernames, URLs and profile blobs are not retained.
    const { data, error } = await supabaseAdmin.from('leads').insert([{
      site_id: siteId,
      user_id: site.user_id,
      name: identity.name,
      status: 'contacted',
      origin: identity.origin,
      metadata: {
        ...identityMetadata(identity),
        outstand_generated_name: identity.name,
        ...(identity.handle ? { social_handle: identity.handle } : {}),
      },
      ...(identity.handle ? { social_networks: { [networkKey]: identity.handle } } : {}),
    }]).select('id').single();
    if (error || !data?.id) throw new OutstandLeadIdentityError();
    return { leadId: data.id, isNewLead: true, taskId: null };
  } catch {
    // Do not leak provider profile values or database internals to logs/clients.
    throw new OutstandLeadIdentityError();
  }
}