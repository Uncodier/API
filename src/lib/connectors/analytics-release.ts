import { authorizeAnalyticsResult, type AnalyticsAuthority } from './supabase-analytics-authorization';
import type { AnalyticsScope } from './supabase-analytics-sources';
import { directQueryMode, type AnalyticsPermit } from './supabase-direct-query';
import type { privateResultBinding } from './private-result-delivery';
import { ConnectorError } from './types';

/** A local capability for a single execution. Not part of the serialized tool envelope. */
export function analyticsRelease(binding:ReturnType<typeof privateResultBinding>, projectRef:string, scope:AnalyticsScope) {
  let stamp:AnalyticsAuthority | undefined;
  const changed = () => new ConnectorError('ACCESS_CHANGED','The analytics admission changed before private delivery.',403);
  const permit:AnalyticsPermit = async request=>{
    if (stamp || request.projectRef!==projectRef || request.scope!==scope) throw changed();
    stamp = await authorizeAnalyticsResult(binding,projectRef,scope,request.source);
  };
  return { permit, async confirm() {
    if (!stamp) throw changed();
    const fresh = await authorizeAnalyticsResult(binding,projectRef,scope,stamp.source);
    if (fresh.grantId!==stamp.grantId || fresh.source!==stamp.source || fresh.scope!==stamp.scope || fresh.projectRef!==stamp.projectRef) throw changed();
    return fresh;
  } };
}

export function prepareReportRelease(binding: ReturnType<typeof privateResultBinding> | null,
  project: string | null | undefined, args: Record<string, unknown>) {
  const scope = directQueryMode(args);
  if (scope === null) return;
  if (!binding || !project) throw new ConnectorError('PRIVATE_DESTINATION_REQUIRED', 'Direct SQL requires a private project-bound instance.', 403);
  return analyticsRelease(binding, project, scope);
}
