import { supabaseAdmin } from '@/lib/database/supabase-client';

/**
 * Validates and returns the requirement's existing site. Despite the historical
 * name, this never creates a site or changes ownership, members or tracking settings.
 */
export async function ensureRequirementTrackingSite(
  requirementId: string,
  originSiteId: string,
): Promise<string> {
  const { data: requirement, error: requirementError } = await supabaseAdmin
    .from('requirements')
    .select('site_id')
    .eq('id', requirementId)
    .maybeSingle();
  if (requirementError || !requirement?.site_id || requirement.site_id !== originSiteId) {
    throw new Error(`Tracking site: requirement ${requirementId} does not belong to the expected site.`);
  }

  const { data: site, error: siteError } = await supabaseAdmin
    .from('sites')
    .select('id')
    .eq('id', requirement.site_id)
    .maybeSingle();
  if (siteError || !site || site.id !== requirement.site_id) {
    throw new Error(`Tracking site: requirement site ${requirement.site_id} is unavailable.`);
  }
  return requirement.site_id;
}

/** Preview domains use the same existing site as the requirement and its tracking script. */
export async function allowRequirementPreviewDomain(params: {
  requirementId: string;
  originSiteId: string;
  previewUrl: string;
}): Promise<void> {
  const trackingId = await ensureRequirementTrackingSite(
    params.requirementId,
    params.originSiteId,
  );
  const preview = new URL(params.previewUrl.trim());
  if (preview.protocol !== 'https:') throw new Error('Preview domain must use HTTPS.');
  const domain = preview.hostname.toLowerCase();
  const { error } = await supabaseAdmin.from('allowed_domains').upsert(
    { site_id: trackingId, domain },
    { onConflict: 'site_id,domain', ignoreDuplicates: true },
  );
  if (error) throw error;
}