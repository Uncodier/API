import { z } from 'zod';
import type { RoutedTool } from '../router/assistantProtocol';
import type { ToolScreenScope } from '../router/screen-access';
import { priceListBatchProperties, priceListBatchSchema } from './batch-schema';
import { requireCommerceBatchManager } from './batch-access';

export function bindPriceListBatchActor(tool: RoutedTool, scope?: ToolScreenScope): RoutedTool {
  if (tool.name !== 'price_lists' || !scope?.siteId || !scope.userId) return tool;
  const { siteId, userId } = scope;
  return {
    ...tool,
    description: `${tool.description} Owners/admins can batch_create lists with item prices or batch_update selected lists and item overrides. Preview first.`,
    parameters: {
      ...tool.parameters,
      properties: {
        ...tool.parameters.properties, ...priceListBatchProperties,
        action: { type: 'string', enum: ['list', 'get', 'batch_create', 'batch_update'],
          description: 'Batch requires owner/admin. Preview (dry_run=true), review, execute with expected_count and dry_run=false. At most 1000 lists and 1000 item operations. No default promotion or automatic rollback.' },
      },
    },
    execute: async args => {
      if (!['batch_create', 'batch_update'].includes(args?.action)) return tool.execute(args);
      if (!z.string().uuid().safeParse(siteId).success || !z.string().uuid().safeParse(userId).success
        || (args.site_id !== undefined && args.site_id !== siteId)) {
        return { success: false, error: 'Price-list batch access denied' };
      }
      const { thought_process: _thought, ...parameters } = args;
      const parsed = priceListBatchSchema.safeParse({ ...parameters, site_id: siteId });
      if (!parsed.success) return { success: false, error: 'Invalid price-list batch parameters', issues: parsed.error.issues };
      let dispatched = false;
      try {
        if (!await requireCommerceBatchManager(siteId, userId)) {
          return { success: false, error: 'Price-list batch requires a site owner or active licensed site admin' };
        }
        const { enforceRequestRateLimit } = await import('@/lib/security/request-rate-limit');
        const denied = await enforceRequestRateLimit(new Request('https://internal.example.test/price-list-batch'), {
          namespace: 'price-list-batch', identity: siteId, limit: 20, windowSeconds: 60, failClosed: true,
        });
        if (denied) return denied.json();
        const { handlePriceListBatch } = await import('./batch');
        dispatched = true;
        return await (await handlePriceListBatch(parsed.data)).json();
      } catch {
        return { success: false, error: dispatched
          ? 'Price-list batch outcome unavailable; inspect current data before retrying because writes may have committed'
          : 'Price-list batch authorization unavailable; no writes started' };
      }
    },
  };
}