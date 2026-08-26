import { supabaseAdmin } from './supabase-server';

/**
 * Returns a Set of lead IDs that are associated with any deal for the given site.
 */
export async function getLeadIdsWithDeals(siteId: string): Promise<Set<string>> {
  // 1. Get all deal IDs for the site
  const { data: deals, error: dealsError } = await supabaseAdmin
    .from('deals')
    .select('id')
    .eq('site_id', siteId);

  if (dealsError || !deals || deals.length === 0) {
    return new Set();
  }

  const dealIds = deals.map((d: any) => d.id);

  // 2. Get all lead IDs for those deals
  const { data: dealLeads, error: dealLeadsError } = await supabaseAdmin
    .from('deal_leads')
    .select('lead_id')
    .in('deal_id', dealIds);

  if (dealLeadsError || !dealLeads || dealLeads.length === 0) {
    return new Set();
  }

  return new Set(dealLeads.map((dl: any) => dl.lead_id));
}

/**
 * Normalizes an array of channel strings into the known supported filters.
 * Supported filters: 'phone', 'email', 'web', 'deals'
 */
export function normalizeChannels(channels?: string[]): string[] {
  if (!channels || !Array.isArray(channels)) return [];
  
  const valid = new Set(['phone', 'email', 'web', 'deals']);
  const result: string[] = [];
  
  for (const c of channels) {
    const norm = c.toLowerCase().trim();
    // website_chat is treated as web for consistency if passed
    if (norm === 'website' || norm === 'website_chat') {
      if (valid.has('web') && !result.includes('web')) result.push('web');
    } else if (valid.has(norm) && !result.includes(norm)) {
      result.push(norm);
    }
  }
  
  return result;
}

/**
 * Builds the PostgREST OR clause and manages empty deal states.
 */
export function buildChannelFilterOrClause(
  channels: string[],
  dealLeadIds: Set<string>
): { orClause: string | null; isEmptyMatch: boolean } {
  if (channels.length === 0) {
    return { orClause: null, isEmptyMatch: false };
  }

  const clauses: string[] = [];

  if (channels.includes('phone')) {
    clauses.push('phone.neq.""');
  }
  
  if (channels.includes('email')) {
    clauses.push('email.neq.""');
  }
  
  if (channels.includes('web')) {
    // Lead website or domain is stored in company JSONB.
    clauses.push('company->>website.neq."",company->>domain.neq.""');
  }

  if (channels.includes('deals')) {
    if (dealLeadIds.size > 0) {
      // Create a comma-separated list of UUIDs
      const uuidList = Array.from(dealLeadIds).join(',');
      clauses.push(`id.in.(${uuidList})`);
    } else {
      // If deals is requested but there are no deal leads, it matches nothing.
      // If it's the ONLY channel, the whole match is empty.
      if (channels.length === 1) {
        return { orClause: null, isEmptyMatch: true };
      }
      // If there are other channels, we just don't add the `id.in.()` clause, 
      // so it will only match the other channels.
    }
  }

  if (clauses.length === 0) {
    return { orClause: null, isEmptyMatch: false };
  }

  return { orClause: clauses.join(','), isEmptyMatch: false };
}
