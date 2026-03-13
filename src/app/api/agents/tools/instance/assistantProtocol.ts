/**
 * Assistant Protocol Wrapper for Instance Tool
 * Provides Create, Read, Update (CRU) operations for instances.
 */

import { z } from 'zod';
import { tool } from 'scrapybara/tools';
import type { UbuntuInstance } from 'scrapybara';
import { instanceCore } from './route';

export interface InstanceToolParams {
  action: 'create' | 'read' | 'update';
  instance_id?: string;
  site_id?: string;
  user_id?: string;
  name?: string;
  activity?: string;
  context?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export function instanceTool(site_id: string, instance_id?: string, user_id?: string) {
  return {
    name: 'instance',
    description: 'Manage AI assistant instances (CRU operations: create, read, update). Use "create" to start a new instance for a specific activity. Use "read" to get details of the current instance or list instances for the site. Use "update" to automatically rename the instance based on context (if it has a generic name or the objective changed) or update other properties. IMPORTANT: You MUST call this tool with action "update" if the instance has a generic name ("Assistant Session", "New Instance", etc.) or if the conversation objective has changed significantly.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'read', 'update'],
          description: 'The action to perform.'
        },
        instance_id: {
          type: 'string',
          description: 'Instance UUID (optional, defaults to current instance).'
        },
        site_id: {
          type: 'string',
          description: 'Site UUID (optional, defaults to current site).'
        },
        activity: {
          type: 'string',
          description: 'Required for create: The main activity or purpose of the new instance.'
        },
        context: {
          type: 'string',
          description: 'Optional for update: Context about what the user is trying to accomplish. If not provided during an update, it will analyze recent conversation history to determine the objective for renaming.'
        },
        name: {
          type: 'string',
          description: 'Optional for update: Explicitly set a new name for the instance.'
        },
        status: {
          type: 'string',
          description: 'Optional for update: Set status (e.g. running, paused, stopped).'
        },
        limit: {
          type: 'number',
          description: 'Optional for read: Limit number of results when listing.'
        },
        offset: {
          type: 'number',
          description: 'Optional for read: Offset for pagination.'
        }
      },
      required: ['action'],
    },
    execute: async (args: InstanceToolParams) => {
      try {
        console.log(`[InstanceTool] 🛠️ Executing action: ${args.action}`);
        
        // Use provided values or defaults from closure
        const targetSiteId = args.site_id || site_id;
        const targetInstanceId = args.instance_id || instance_id;
        const targetUserId = args.user_id || user_id;

        return await instanceCore({
          ...args,
          site_id: targetSiteId,
          instance_id: targetInstanceId,
          user_id: targetUserId
        });
      } catch (error: any) {
        console.error(`[InstanceTool] ❌ Unexpected error:`, error);
        return { success: false, error: error.message || 'An unexpected error occurred while managing the instance.' };
      }
    },
  };
}

/**
 * Creates an instance tool for Scrapybara SDK compatibility
 */
export function instanceToolScrapybara(instance: UbuntuInstance, site_id: string, db_instance_id?: string) {
  return tool({
    name: 'instance',
    description: 'Manage AI assistant instances (CRU operations: create, read, update). Use "create" to start a new instance for a specific activity. Use "read" to get details of the current instance or list instances for the site. Use "update" to automatically rename the instance based on context (if it has a generic name or the objective changed) or update other properties. IMPORTANT: You MUST call this tool with action "update" if the instance has a generic name ("Assistant Session", "New Instance", etc.) or if the conversation objective has changed significantly.',
    parameters: z.object({
      action: z.enum(['create', 'read', 'update']).describe('The action to perform.'),
      instance_id: z.string().optional().describe('Instance UUID (optional, defaults to current instance).'),
      site_id: z.string().optional().describe('Site UUID (optional, defaults to current site).'),
      activity: z.string().optional().describe('Required for create: The main activity or purpose of the new instance.'),
      context: z.string().optional().describe('Optional for update: Context about what the user is trying to accomplish.'),
      name: z.string().optional().describe('Optional for update: Explicitly set a new name for the instance.'),
      status: z.string().optional().describe('Optional for update: Set status.'),
      limit: z.number().optional(),
      offset: z.number().optional(),
    }),
    execute: async (args) => {
      try {
        console.log(`[InstanceTool-Scrapybara] 🛠️ Executing action: ${args.action}`);
        
        let targetInstanceId = args.instance_id || db_instance_id;
        
        // If we don't have the db instance id, look it up by provider_instance_id
        if (!targetInstanceId && args.action !== 'create') {
          const { supabaseAdmin } = await import('@/lib/database/supabase-client');
          const { data: instanceRecord } = await supabaseAdmin
            .from('remote_instances')
            .select('id')
            .eq('provider_instance_id', (instance as any).id)
            .single();

          targetInstanceId = instanceRecord?.id;
        }

        const targetSiteId = args.site_id || site_id;

        return await instanceCore({
          action: args.action,
          site_id: targetSiteId,
          instance_id: targetInstanceId,
          activity: args.activity,
          context: args.context,
          name: args.name,
          status: args.status,
          limit: args.limit,
          offset: args.offset
        });
      } catch (error: any) {
        console.error(`[InstanceTool-Scrapybara] ❌ Unexpected error:`, error);
        return { success: false, error: error.message || 'An unexpected error occurred while managing the instance.' };
      }
    },
  });
}
