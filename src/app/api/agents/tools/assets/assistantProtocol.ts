/**
 * Assistant Protocol Wrapper for Assets Tool
 * Unified tool for managing assets (create, list, update)
 */

import { getAssetCore } from './get/core';
import { createAssetCore } from './create/core';
import { updateAssetCore } from './update/core';
import { canToolPrincipalAccessSite } from '@/lib/security/tool-request-principal';

export interface AssetsToolParams {
  action: 'create' | 'list' | 'update';
  
  // Common/Create/Update params
  asset_id?: string;
  name?: string;
  file_type?: string;
  instance_id?: string;
  content?: string;
  metadata?: string;
  
  // List params
  limit?: number;
  offset?: number;
}

export function assetsTool(site_id: string, user_id?: string) {
  return {
    name: 'assets',
    description:
      'Manage assets linked to robot instances. Use action="create" with content and a text file_type to create an inline text asset; upload media through the media tools instead. Use action="update" to update an existing asset. Use action="list" to get assets.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'update'],
          description: 'Action to perform on assets.'
        },
        asset_id: { type: 'string', description: 'Asset UUID (required for update)' },
        name: { type: 'string', description: 'Asset name' },
        file_type: { type: 'string', description: 'File type (e.g. text/plain, image/png)' },
        instance_id: { type: 'string', description: 'Robot instance UUID (required for create/list)' },
        content: { type: 'string', description: 'Text content of the asset' },
        metadata: { type: 'string', description: 'Metadata JSON (as string)' },
        
        limit: { type: 'number', description: 'Max results' },
        offset: { type: 'number', description: 'Pagination offset' },
      },
      required: ['action'],
    },
    execute: async (args: AssetsToolParams) => {
      const { action, ...params } = args;

      if (action === 'create') {
        if (user_id && !await canToolPrincipalAccessSite({ internal: false, userId: user_id, siteId: site_id }, site_id)) {
          throw new Error('Forbidden');
        }
        if (!params.name || !params.file_type || !params.instance_id) {
           throw new Error('Missing required fields for create asset: name, file_type, instance_id');
        }

        const body = {
          ...params,
          metadata: params.metadata && typeof params.metadata === 'string' ? JSON.parse(params.metadata) : params.metadata,
          site_id,
        };

        const asset = await createAssetCore(body);
        return { success: true, asset };
      }

      if (action === 'update') {
        if (!params.asset_id) {
            throw new Error('Missing required field for update asset: asset_id');
        }
        const body = {
          ...params,
          metadata: params.metadata && typeof params.metadata === 'string' ? JSON.parse(params.metadata) : params.metadata,
          site_id,
        };
        const asset = await updateAssetCore(body);
        return { success: true, asset };
      }

      if (action === 'list') {
        const filters = {
          ...params,
          site_id,
        };
        // @ts-ignore
        return getAssetCore(filters);
      }

      throw new Error(`Invalid action: ${action}`);
    },
  };
}
