import { v5 as uuidv5 } from 'uuid';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import {
  OutstandParticipantIdentityError,
  type OutstandParticipantIdentity,
} from '@/lib/integrations/outstand/participant-identity';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

async function lookup(siteId: string, identity: OutstandParticipantIdentity, leadId?: string) {
  let query = supabaseAdmin.from('leads').select('id, name, metadata, social_networks').eq('site_id', siteId);
  query = leadId ? query.eq('id', leadId) : query
    .eq('metadata->>outstand_dm_participant_id', identity.participantId)
    .eq('metadata->>outstand_dm_social_account_id', identity.socialAccountId);
  const { data, error } = await query.limit(2);
  if (error || !Array.isArray(data) || data.length > 1) throw new OutstandParticipantIdentityError();
  return data[0] || null;
}

/** IGSIDs are account-scoped DM identities, NOT public comment author IDs. */
export async function ensureOutstandDmLead(
  siteId: string,
  identity: OutstandParticipantIdentity,
  linkedLeadId?: string | null,
  cachedIdentity: OutstandParticipantIdentity = identity,
): Promise<{ leadId: string; identity: OutstandParticipantIdentity }> {
  if (!siteId || !identity.participantId || !identity.socialAccountId) throw new OutstandParticipantIdentityError();
  // The existing lead PK also serializes concurrent first sightings. No lookup/insert race duplicates.
  const generatedId = uuidv5(JSON.stringify([
    'makinari:outstand:instagram-dm-lead:v1', siteId, identity.socialAccountId, identity.participantId,
  ]), uuidv5.URL);

  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const lead = await lookup(siteId, identity, linkedLeadId || undefined);
      if (linkedLeadId && !lead) throw new OutstandParticipantIdentityError();
      const metadata = record(lead?.metadata);
      if ((metadata.outstand_dm_participant_id && metadata.outstand_dm_participant_id !== identity.participantId)
        || (metadata.outstand_dm_social_account_id && metadata.outstand_dm_social_account_id !== identity.socialAccountId)) {
        throw new OutstandParticipantIdentityError();
      }

      // A manual CRM link is per-conversation, not a second canonical DM identity.
      // Stamping this tuple onto it would duplicate the original automatic lead
      // and make the next unlinked conversation's lookup ambiguous.
      if (linkedLeadId && !metadata.outstand_dm_participant_id && !metadata.outstand_dm_social_account_id) {
        return { leadId: lead.id, identity: {
          ...identity,
          displayName: identity.displayName || cachedIdentity.displayName,
          username: identity.username || cachedIdentity.username,
          profilePicture: identity.profilePicture || cachedIdentity.profilePicture,
        } };
      }
      // Raw provider fields win, but a null refresh must use the latest canonical
      // lead identity before an older conversation cache (including CAS retries).
      const known = (key: string) => typeof metadata[key] === 'string' ? metadata[key] as string : '';
      const resolved = {
        ...identity,
        displayName: identity.displayName || known('outstand_dm_display_name') || cachedIdentity.displayName,
        username: identity.username || known('outstand_dm_username') || cachedIdentity.username,
        profilePicture: identity.profilePicture || known('outstand_dm_profile_picture') || cachedIdentity.profilePicture,
      };
      const availableName = resolved.displayName || resolved.username;

      const identityMetadata = {
        ...metadata,
        outstand_dm_participant_id: identity.participantId,
        outstand_dm_social_account_id: identity.socialAccountId,
        ...(resolved.displayName ? { outstand_dm_display_name: resolved.displayName } : {}),
        ...(resolved.username ? { outstand_dm_username: resolved.username } : {}),
        ...(resolved.profilePicture ? { outstand_dm_profile_picture: resolved.profilePicture } : {}),
        outstand_dm_identity_status: availableName ? 'available' : 'unavailable',
      };

      if (lead) {
        // Keep manually linked CRM contacts, all comment metadata and every manual name.
        const canRename = Boolean(availableName && metadata.outstand_dm_generated_name === lead.name);
        const networks = record(lead.social_networks);
        const canUpdateHandle = resolved.username && (!networks.instagram || networks.instagram === metadata.outstand_dm_username);
        const update = {
          metadata: { ...identityMetadata, ...(canRename ? { outstand_dm_generated_name: availableName } : {}) },
          ...(canRename ? { name: availableName } : {}),
          ...(canUpdateHandle ? { social_networks: { ...networks, instagram: resolved.username } } : {}),
        };
        let query = supabaseAdmin.from('leads').update(update).eq('site_id', siteId).eq('id', lead.id);
        query = lead.metadata == null ? query.is('metadata', null) : query.eq('metadata', JSON.stringify(lead.metadata));
        if (canRename) query = query.eq('name', lead.name);
        if (canUpdateHandle) query = lead.social_networks == null
          ? query.is('social_networks', null) : query.eq('social_networks', JSON.stringify(lead.social_networks));
        const { data, error } = await query.select('id').maybeSingle();
        if (error) throw new OutstandParticipantIdentityError();
        if (data) return { leadId: data.id, identity: resolved };
        continue; // A concurrent manual edit/refresh wins; reload before merging.
      }

      const { data: site, error: siteError } = await supabaseAdmin.from('sites')
        .select('id, user_id').eq('id', siteId).single();
      if (siteError || site?.id !== siteId || !site.user_id) throw new OutstandParticipantIdentityError();
      const name = availableName || 'Instagram contact';
      const { data, error } = await supabaseAdmin.from('leads').insert([{
        id: generatedId,
        site_id: siteId,
        user_id: site.user_id,
        origin: 'instagram',
        status: 'contacted',
        name,
        metadata: { ...identityMetadata, source: 'outstand_dm', outstand_dm_generated_name: name },
        ...(resolved.username ? { social_networks: { instagram: resolved.username } } : {}),
      }]).select('id').single();
      if (!error && data?.id) return { leadId: data.id, identity: resolved };
      if (error?.code !== '23505') throw new OutstandParticipantIdentityError();
      // A concurrent insert must be found by the same scoped identity on retry.
    }
  } catch {
    throw new OutstandParticipantIdentityError();
  }
  throw new OutstandParticipantIdentityError();
}