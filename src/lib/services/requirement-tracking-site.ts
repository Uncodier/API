import { v5 as uuidv5 } from 'uuid';
import { supabaseAdmin } from '@/lib/database/supabase-client';

/** One site per generated application, stable across sandbox retries and deployments. */
function trackingSiteId(requirementId: string): string {
  return uuidv5(`makinari:requirement-tracking-site:${requirementId}`, uuidv5.URL);
}

async function requirementSiteContext(requirementId: string, originSiteId: string) {
  const { data: requirement, error: requirementError } = await supabaseAdmin
    .from('requirements')
    .select('site_id, title')
    .eq('id', requirementId)
    .maybeSingle();
  if (requirementError || !requirement || requirement.site_id !== originSiteId) {
    throw new Error(`Tracking site: requirement ${requirementId} does not belong to the expected site.`);
  }

  const { data: origin, error: originError } = await supabaseAdmin
    .from('sites')
    .select('user_id')
    .eq('id', originSiteId)
    .maybeSingle();
  if (originError || !origin?.user_id) {
    throw new Error(`Tracking site: owner of site ${originSiteId} is unavailable.`);
  }
  return { title: requirement.title, ownerId: origin.user_id };
}

/** Only returns an existing, correctly owned site; never creates one for a preview alone. */
export async function existingRequirementTrackingSiteId(
  requirementId: string,
  originSiteId: string,
): Promise<string | null> {
  const { ownerId } = await requirementSiteContext(requirementId, originSiteId);
  const id = trackingSiteId(requirementId);
  const { data: site, error } = await supabaseAdmin
    .from('sites')
    .select('id, user_id')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!site) return null;
  if (site.user_id !== ownerId) {
    throw new Error(`Tracking site ${id} has a different owner.`);
  }
  return id;
}

/** Called only when an application layout is present and tracking can be injected. */
export async function ensureRequirementTrackingSite(
  requirementId: string,
  originSiteId: string,
): Promise<string> {
  const { title, ownerId } = await requirementSiteContext(requirementId, originSiteId);
  const id = trackingSiteId(requirementId);
  const { data: site, error: lookupError } = await supabaseAdmin
    .from('sites')
    .select('id, user_id')
    .eq('id', id)
    .maybeSingle();
  if (lookupError) throw lookupError;
  if (site) {
    if (site.user_id !== ownerId) throw new Error(`Tracking site ${id} has a different owner.`);
    return id;
  }

  const { error } = await supabaseAdmin.from('sites').insert({
    id,
    name: title || `Application ${requirementId.slice(0, 8)}`,
    user_id: ownerId,
    tracking: { track_visitors: true, track_actions: true, record_screen: false },
  });
  // Concurrent cron runs can both observe a missing site. The primary key
  // makes creation idempotent; verify ownership even in that race.
  if (error && error.code !== '23505') throw error;
  if (error) {
    const { data: existing, error: readError } = await supabaseAdmin
      .from('sites')
      .select('user_id')
      .eq('id', id)
      .maybeSingle();
    if (readError || existing?.user_id !== ownerId) {
      throw new Error(`Tracking site ${id} could not be safely reused.`);
    }
  }
  return id;
}

/** Domains authorize only the tracking site, not the site that ordered the app. */
export async function allowRequirementPreviewDomain(params: {
  requirementId: string;
  originSiteId: string;
  previewUrl: string;
}): Promise<void> {
  const trackingId = await existingRequirementTrackingSiteId(
    params.requirementId,
    params.originSiteId,
  );
  if (!trackingId) return;

  const preview = new URL(params.previewUrl.trim());
  if (preview.protocol !== 'https:') throw new Error('Preview domain must use HTTPS.');
  const domain = preview.hostname.toLowerCase();
  const { error } = await supabaseAdmin.from('allowed_domains').upsert(
    { site_id: trackingId, domain },
    { onConflict: 'site_id,domain', ignoreDuplicates: true },
  );
  if (error) throw error;
}