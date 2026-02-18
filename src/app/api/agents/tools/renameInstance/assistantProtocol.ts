/**
 * Assistant Protocol Wrapper for Rename Instance Tool
 * Formats the tool for OpenAI/assistant compatibility
 */

import { tool } from 'scrapybara/tools';
import { z } from 'zod';
import type { UbuntuInstance } from 'scrapybara';

export interface RenameInstanceToolParams {
  context?: string;
}

/**
 * Creates a renameInstance tool for OpenAI/assistant compatibility
 * @param site_id - The site ID associated with the instance
 * @param instance_id - The instance ID to rename
 * @returns Tool definition compatible with OpenAI function calling
 */
export function renameInstanceTool(site_id: string, instance_id?: string) {
  return {
    name: 'rename_instance',
    description: 'Automatically rename the instance based on the current user context and objective. IMPORTANT: You MUST call this tool automatically if: 1) The instance has a generic/non-descriptive name (e.g., "Assistant Session", "New Instance", "Untitled", or similar generic names), OR 2) The current instance name does not accurately summarize or reflect the conversation/chat content. This tool will analyze the conversation context and generate a descriptive name that reflects what the user is actually trying to accomplish. Only updates the name if the objective has significantly changed from the stored objective.',
    parameters: {
      type: 'object',
      properties: {
        context: {
          type: 'string',
          description: 'Optional context about what the user is trying to accomplish. If not provided, will analyze recent conversation history from instance logs to determine the objective.',
        },
        site_id: {
          type: 'string',
          description: 'Site UUID (required).'
        }
      },
      required: ['site_id'],
    },
    execute: async (args: RenameInstanceToolParams) => {
      try {
        console.log(`[RenameInstanceTool] 🏷️ Executing instance rename`);
        console.log(`[RenameInstanceTool] 🏢 Site ID: ${site_id}`);
        console.log(`[RenameInstanceTool] 📝 Instance ID: ${instance_id || 'Not provided'}`);

        if (!instance_id) {
          return {
            success: false,
            error: 'instance_id is required but was not provided',
            renamed: false,
          };
        }

        // Call the rename core function directly (server-side)
        const { renameInstanceCore } = await import('./route');
        const result = await renameInstanceCore(instance_id, args.site_id, args.context);

        if (result.renamed) {
          console.log(`[RenameInstanceTool] ✅ Instance renamed: "${result.old_name}" → "${result.new_name}"`);
          return {
            success: true,
            renamed: true,
            old_name: result.old_name,
            new_name: result.new_name,
            similarity: result.similarity,
            message: result.message || `Instance renamed from "${result.old_name}" to "${result.new_name}"`,
          };
        } else {
          console.log(`[RenameInstanceTool] ⏭️ Name unchanged: ${result.reason}`);
          return {
            success: true,
            renamed: false,
            current_name: result.current_name,
            similarity: result.similarity,
            reason: result.reason || 'Objective has not changed significantly',
            message: `Instance name unchanged: ${result.reason}`,
          };
        }
      } catch (error: any) {
        console.error(`[RenameInstanceTool] ❌ Unexpected error:`, error);
        
        // Re-throw the error to ensure it's treated as a tool execution failure
        throw error;
      }
    },
  };
}

/**
 * Helper function to create the tool with a specific site_id
 * This is useful for robot integrations where site_id is known
 */
export function createRenameInstanceTool(site_id: string) {
  if (!site_id || typeof site_id !== 'string') {
    throw new Error('site_id is required and must be a string');
  }
  
  return renameInstanceTool(site_id);
}

/**
 * Creates a renameInstance tool for Scrapybara SDK compatibility
 * Uses tool() helper from scrapybara/tools with Zod schemas
 * @param instance - The Scrapybara UbuntuInstance
 * @param site_id - The site ID associated with the instance
 * @param instance_id - Optional database instance ID. If not provided, will look it up by provider_instance_id
 * @returns Tool definition compatible with Scrapybara SDK
 */
export function renameInstanceToolScrapybara(instance: UbuntuInstance, site_id: string, instance_id?: string) {
  return tool({
    name: 'rename_instance',
    description: 'Automatically rename the instance based on the current user context and objective. IMPORTANT: You MUST call this tool automatically if: 1) The instance has a generic/non-descriptive name (e.g., "Assistant Session", "New Instance", "Untitled", or similar generic names), OR 2) The current instance name does not accurately summarize or reflect the conversation/chat content. This tool will analyze the conversation context and generate a descriptive name that reflects what the user is actually trying to accomplish. Only updates the name if the objective has significantly changed from the stored objective.',
    parameters: z.object({
      context: z.string().optional().describe('Optional context about what the user is trying to accomplish. If not provided, will analyze recent conversation history from instance logs to determine the objective.'),
    }),
    execute: async (args) => {
      try {
        console.log(`[RenameInstanceTool-Scrapybara] 🏷️ Executing instance rename`);
        console.log(`[RenameInstanceTool-Scrapybara] 🏢 Site ID: ${site_id}`);
        console.log(`[RenameInstanceTool-Scrapybara] 📝 Context: ${args.context?.substring(0, 100) || 'None'}...`);

        // Get instance_id - use provided one or look it up by provider_instance_id
        let dbInstanceId = instance_id;
        
        if (!dbInstanceId) {
          const { supabaseAdmin } = await import('@/lib/database/supabase-client');
          // The Scrapybara instance has an id that corresponds to provider_instance_id in our DB
          const { data: instanceRecord } = await supabaseAdmin
            .from('remote_instances')
            .select('id')
            .eq('provider_instance_id', (instance as any).id)
            .single();

          dbInstanceId = instanceRecord?.id;
        }

        if (!dbInstanceId) {
          throw new Error('Could not find instance_id for Scrapybara instance');
        }

        // Call the rename core function directly (server-side)
        const { renameInstanceCore } = await import('./route');
        const result = await renameInstanceCore(dbInstanceId, args.context);

        if (result.renamed) {
          console.log(`[RenameInstanceTool-Scrapybara] ✅ Instance renamed: "${result.old_name}" → "${result.new_name}"`);
          return {
            success: true,
            renamed: true,
            old_name: result.old_name,
            new_name: result.new_name,
            similarity: result.similarity,
            message: result.message || `Instance renamed from "${result.old_name}" to "${result.new_name}"`,
          };
        } else {
          console.log(`[RenameInstanceTool-Scrapybara] ⏭️ Name unchanged: ${result.reason}`);
          return {
            success: true,
            renamed: false,
            current_name: result.current_name,
            similarity: result.similarity,
            reason: result.reason || 'Objective has not changed significantly',
            message: `Instance name unchanged: ${result.reason}`,
          };
        }
      } catch (error: any) {
        console.error(`[RenameInstanceTool-Scrapybara] ❌ Unexpected error:`, error);
        throw error;
      }
    },
  });
}
