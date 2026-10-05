import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { sanitizeMigrationRepairContext } from '../apps-platform/migration-repair-policy';
import { redactRuntimeSecrets } from '@/app/api/cron/shared/runtime-log-context';

export interface HarnessDiagnosticContext {
  siteId: string;
  instanceId: string;
  requirementId?: string;
  /** Describes this invocation, never the capabilities of a different worker. */
  runtime: string;
  toolNames: string[];
}

export function sanitizeHarnessData(value: unknown, depth = 0): unknown {
  if (depth > 15) return '[DEPTH_LIMIT]';
  if (typeof value === 'string') {
    // Strip both URL credentials before email redaction can consume their @ delimiter.
    const withoutUserinfo = value.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
    return redactRuntimeSecrets(sanitizeMigrationRepairContext(withoutUserinfo))
      .replace(/([?&](?:token|key|signature|secret|password|credential|x-amz-signature)=)[^\s&#"']+/gi, '$1[REDACTED]');
  }
  if (Array.isArray(value)) return value.map(item => sanitizeHarnessData(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
    /(?:password|secret|authorization|cookie|api.?key|access.?token|refresh.?token|private.?key|credential|screenshot_base64)/i.test(key)
      ? '[REDACTED]' : sanitizeHarnessData(entry, depth + 1)]));
  return value;
}

export const REQUIREMENT_DIAGNOSTIC_COLUMNS = 'id,site_id,status,title,instructions,type,metadata,backlog,backlog_revision,updated_at,cron_lock_active,cron_lock_expires_at';

/** All identities come from the host closure, not from tool arguments. No running lease is needed to read a hold. */
export async function loadHarnessScope(context: HarnessDiagnosticContext) {
  z.string().uuid().parse(context.siteId);
  z.string().uuid().parse(context.instanceId);
  const { data: instance, error: instanceError } = await supabaseAdmin.from('remote_instances')
    .select('id,site_id,status,is_archived').eq('id', context.instanceId).eq('site_id', context.siteId).maybeSingle();
  if (instanceError || !instance || instance.is_archived) throw new Error('Diagnostic instance scope is unavailable.');

  let requirementId = context.requirementId;
  if (!requirementId) {
    const { data: owned, error } = await supabaseAdmin.from('requirements').select('id')
      .eq('site_id', context.siteId)
      .or(`metadata->>runner_instance_id.eq.${context.instanceId},metadata->>assistant_origin_instance_id.eq.${context.instanceId}`)
      .in('status', ['backlog', 'pending', 'in-progress', 'blocked', 'on-review']).limit(2);
    if (error || owned?.length !== 1) throw new Error('No unambiguous requirement is bound to this diagnostic session.');
    requirementId = owned[0].id;
  }
  z.string().uuid().parse(requirementId);
  const { data: requirement, error } = await supabaseAdmin.from('requirements').select(REQUIREMENT_DIAGNOSTIC_COLUMNS)
    .eq('id', requirementId).eq('site_id', context.siteId).maybeSingle();
  if (error || !requirement) throw new Error('Diagnostic requirement scope is unavailable.');
  const owner = requirement.metadata?.runner_instance_id;
  const origin = requirement.metadata?.assistant_origin_instance_id;
  const { data: plans, error: planError } = await supabaseAdmin.from('instance_plans')
    .select('id,instance_id,site_id,status,title,metadata,steps,updated_at,created_at')
    .eq('site_id', context.siteId).contains('metadata', { requirement_id: requirementId })
    .order('created_at', { ascending: false }).limit(51);
  if (planError) throw new Error('Cannot verify requirement-linked plans.');
  let linked = (plans || []).some(plan => plan.instance_id === context.instanceId);
  if (!linked && owner !== context.instanceId && origin !== context.instanceId) {
    // The caller's historical association may be older than the bounded display page.
    const { data: association, error: associationError } = await supabaseAdmin.from('instance_plans')
      .select('id').eq('site_id', context.siteId).eq('instance_id', context.instanceId)
      .contains('metadata', { requirement_id: requirementId }).limit(1);
    if (associationError) throw new Error('Cannot verify caller association with this requirement.');
    linked = Array.isArray(association) && association.length > 0;
  }
  if (owner !== context.instanceId && origin !== context.instanceId && !linked) {
    throw new Error('This instance is not associated with the diagnostic requirement.');
  }
  return { requirement, instance, plans: (plans || []).slice(0, 50), plansTruncated: (plans || []).length > 50,
    canAuthor: owner === context.instanceId || origin === context.instanceId };
}

export type HarnessScope = Awaited<ReturnType<typeof loadHarnessScope>>;

/** Explicit references can include another instance; conflicting references never belong to this requirement. */
export function logBelongsToRequirement(log: Record<string, any>, requirementId: string): boolean {
  const references = [log.details?.requirement_id, log.tool_args?.requirement_id]
    .filter((id): id is string => typeof id === 'string' && !!id);
  return references.length > 0 && references.every(id => id === requirementId);
}