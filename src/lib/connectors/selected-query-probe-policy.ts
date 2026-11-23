import type {CatalogOnlyAccount} from './selected-catalog-account';

export const PROBE_PROVIDER_ACTION = 'SUPABASE_RUN_READ_ONLY_QUERY';
export const SELECTED_QUERY_PROBE = PROBE_PROVIDER_ACTION;
export function selectedQueryProbeEligible({connector:c,policy:p,requestOnly}:CatalogOnlyAccount) {
  return !requestOnly && c.toolkit_slug==='supabase' && /^[a-z]{20}$/.test(c.supabase_project_ref ?? '') &&
    c.enabled && !!c.verified_at && c.provider_status==='ACTIVE' && !c.revocation_pending && c.revocation_dispatched===false &&
    p.allowed_hosts.includes('assistant') &&
    (p.tool_access_mode==='all' || (p.tool_access_mode==='selected' && p.allowed_tools.includes(PROBE_PROVIDER_ACTION)));
}
