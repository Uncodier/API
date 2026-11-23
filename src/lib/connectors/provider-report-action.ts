/** Only this exact Composio action currently has a Makinari reporting projection. */
export const SUPABASE_CATALOG_SLUG = 'SUPABASE_RUN_READ_ONLY_QUERY';

export function isSupabaseReportAction(toolkit: string, slug: string) {
  return toolkit === 'supabase' && slug === SUPABASE_CATALOG_SLUG;
}