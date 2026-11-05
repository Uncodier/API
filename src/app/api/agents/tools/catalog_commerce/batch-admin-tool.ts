import { z } from 'zod';
import { batchToolProperties, batchUpdateSchema } from './handlers/batch-schema';
import type { RoutedTool } from '../router/assistantProtocol';
import type { ToolScreenScope } from '../router/screen-access';

/** Only the administrative router supplies this host-owned scope. Never derive it from tool args. */
export function bindCatalogBatchActor(tool: RoutedTool, scope?: ToolScreenScope): RoutedTool {
  if (tool.name !== 'catalog_commerce' || !scope?.siteId || !scope.userId) return tool;
  const { siteId, userId } = scope;
  return {
    ...tool,
    parameters: {
      ...tool.parameters,
      properties: {
        ...tool.parameters.properties, ...batchToolProperties,
        action: {
          ...tool.parameters.properties.action,
          enum: [...tool.parameters.properties.action.enum.filter((action: string) => action !== 'batch_update'), 'batch_update'],
          description: 'batch_update requires a site owner or active site admin: select item_ids or all_items=true, supply changes/taxes/inventory. Preview first (dry_run=true), then use preview IDs, dry_run=false and expected_count. Maximum 1000 items. Partial operations are reported; no automatic rollback.',
        },
      },
    },
    execute: async (args) => {
      if (args?.action !== 'batch_update') return tool.execute(args);
      if (!z.string().uuid().safeParse(siteId).success || !z.string().uuid().safeParse(userId).success
        || (args.site_id !== undefined && args.site_id !== siteId)) {
        return { success: false, error: 'Catalog batch access denied' };
      }
      // thought_process is router transport metadata, not a writable catalog property.
      const { thought_process: _thought, ...parameters } = args;
      const parsed = batchUpdateSchema.safeParse({ ...parameters, site_id: siteId });
      if (!parsed.success) return { success: false, error: 'Invalid catalog batch parameters', issues: parsed.error.issues };
      const { supabaseAdmin } = await import('@/lib/database/supabase-client');
      const { enforceRequestRateLimit } = await import('@/lib/security/request-rate-limit');
      const access = await supabaseAdmin.rpc('site_user_has_effective_access', { p_site_id: siteId, p_user_id: userId });
      const site = await supabaseAdmin.from('sites').select('user_id').eq('id', siteId).maybeSingle();
      if (access.error || access.data !== true || site.error || !site.data) {
        return { success: false, error: 'Catalog batch site access denied' };
      }
      // Mirror the location ACL's fail-closed handling of ambiguous memberships.
      const members = await supabaseAdmin.from('site_members').select('id, role', { count: 'exact' })
        .eq('site_id', siteId).eq('user_id', userId).eq('status', 'active');
      if (members.error || members.count === null || members.count === undefined || members.count > 1) {
        return { success: false, error: 'Catalog batch membership access denied' };
      }
      // With exactly one active membership, effective access above also verifies
      // its license. Owners/admins are exempt from location restrictions in the
      // database ACL; item/location tenancy is still checked by the batch handler.
      const manager = members.count === 1 && members.data?.length === 1
        && ['owner', 'admin'].includes(members.data[0].role);
      if (site.data.user_id !== userId && !manager) {
        return { success: false, error: 'Catalog batch requires a site owner or active site admin' };
      }
      const denied = await enforceRequestRateLimit(new Request('https://internal.example.test/catalog-batch'), {
        namespace: 'catalog-batch', identity: siteId, limit: 20, windowSeconds: 60, failClosed: true,
      });
      if (denied) return denied.json();
      // No HTTP service-credential hop: the actor cannot be substituted by request/model fields.
      // Return the structured failure as data so router/agent retains completed and uncertain operations.
      const { handleBatchUpdate } = await import('./handlers/batch');
      return (await handleBatchUpdate(parsed.data)).json();
    },
  };
}