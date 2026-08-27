/**
 * Assistant Protocol Wrapper for Entitlements Tool
 */
import { fetchApiTool } from '@/app/api/agents/tools/utils/fetch-helper';

export interface EntitlementsToolParams {
  action: 'list' | 'get' | 'update';
  
  id?: string;
  site_id?: string;
  lead_id?: string;
  buyer_user_id?: string;
  owner_site_id?: string;
  catalog_item_id?: string;
  status?: string;
  source_type?: string;
  expires_at?: string;
  uses_total?: number;
  uses_remaining?: number;
  
  limit?: number;
  offset?: number;
}

export function entitlementsTool(current_site_id?: string) {
  return {
    name: 'entitlements',
    description:
      'Read and manage digital entitlements. Use action="list" to find entitlements by buyer or status. Use action="get" to read a single entitlement. Use action="update" to change status (e.g. to "revoked" or "used") or update expires_at. Do not invent grants here; entitlements are normally created via Stripe webhook after a checkout.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'get', 'update'],
          description: 'Action to perform on entitlements.'
        },
        id: { type: 'string', description: 'Entitlement UUID (required for get, update)' },
        site_id: { type: 'string', description: 'Seller site UUID' },
        lead_id: { type: 'string', description: 'Lead UUID. list resolves the lead buyer and filters by buyer_user_id.' },
        buyer_user_id: { type: 'string', description: 'Buyer user UUID' },
        owner_site_id: { type: 'string', description: 'Destination owner site UUID' },
        catalog_item_id: { type: 'string', description: 'Catalog item UUID' },
        status: { type: 'string', enum: ['active', 'revoked', 'expired', 'used'], description: 'Entitlement status: active, revoked, expired, used' },
        source_type: { type: 'string', enum: ['purchase', 'subscription'], description: 'Source type: purchase or subscription' },
        expires_at: { type: 'string', description: 'Expiration date (ISO string)' },
        uses_total: { type: 'number', description: 'Total uses granted' },
        uses_remaining: { type: 'number', description: 'Uses remaining' },
        limit: { type: 'number', description: 'Limit results for list' },
        offset: { type: 'number', description: 'Offset results for list' },
      },
      required: ['action'],
    },
    execute: async (args: EntitlementsToolParams) => {
      const { action, ...params } = args;

      if ((action === 'update' || action === 'get') && !params.id) {
        throw new Error(`Missing required field id for action ${action}`);
      }

      const body = {
        action,
        ...params,
        site_id: params.site_id || current_site_id,
      };

      return await fetchApiTool('/api/agents/tools/entitlements', body, `Entitlements ${action} failed`);
    }
  };
}
