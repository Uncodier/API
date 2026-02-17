/**
 * Assistant Protocol Wrapper for Get Memories Tool
 * Retrieves previously saved memories from agent_memories
 */

import { tool } from 'scrapybara/tools';
import { z } from 'zod';
import type { UbuntuInstance } from 'scrapybara';
import { findGrowthRobotAgent } from '@/lib/helpers/agent-finder';
import { getAgentMemories } from '@/lib/services/agent-memory-tools-service';

export interface GetMemoriesToolParams {
  search_query?: string;
  type?: string;
  limit?: number;
  client_id?: string;
  project_id?: string;
  task_id?: string;
}

/**
 * Creates a get_memories tool for OpenAI/assistant compatibility
 * @param site_id - The site ID
 * @param _user_id - The user ID (optional, agent provides userId)
 * @param _instance_id - Reserved for future instance-scoped filtering
 */
export function getMemoriesTool(site_id: string, _user_id?: string, _instance_id?: string) {
  return {
    name: 'get_memories',
    description:
      'Search and retrieve previously saved memories. Use when you need to recall user preferences, past research findings, decisions, or any information the user or assistant saved earlier. Optionally filter by client_id, project_id, or task_id to get context-specific memories.',
    parameters: {
      type: 'object',
      properties: {
        search_query: {
          type: 'string',
          description:
            'Optional search term to filter memories (searches in content, summary, and key).',
        },
        type: {
          type: 'string',
          description:
            'Optional memory type filter. Default is "assistant_note" for assistant-saved notes.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of memories to return. Default 10, max 50.',
        },
        client_id: {
          type: 'string',
          description: 'Optional. Filter memories scoped to a specific client.',
        },
        project_id: {
          type: 'string',
          description: 'Optional. Filter memories scoped to a specific project.',
        },
        task_id: {
          type: 'string',
          description: 'Optional. Filter memories scoped to a specific task.',
        },
      },
      required: [],
    },
    execute: async (args: GetMemoriesToolParams) => {
      try {
        console.log(`[GetMemoriesTool] 🔍 Retrieving memories`);
        console.log(`[GetMemoriesTool] 🏢 Site ID: ${site_id}`);

        const agent = await findGrowthRobotAgent(site_id);
        if (!agent) {
          return {
            success: false,
            error: 'Memory tools require a Growth Robot agent for this site.',
            memories: [],
          };
        }

        const result = await getAgentMemories(agent.agentId, {
          search_query: args.search_query,
          type: args.type || 'assistant_note',
          limit: args.limit ?? 10,
          client_id: args.client_id,
          project_id: args.project_id,
          task_id: args.task_id,
        });

        if (!result.success) {
          return {
            success: false,
            error: result.error || 'Failed to retrieve memories',
            memories: [],
          };
        }

        const memories = (result.memories || []).map((m) => ({
          id: m.id,
          content: m.content,
          summary: m.summary,
          key: m.key,
          created_at: m.created_at,
        }));

        return {
          success: true,
          memories,
          count: memories.length,
          message:
            memories.length > 0
              ? `Found ${memories.length} memory(ies).`
              : 'No memories found matching the criteria.',
        };
      } catch (error: unknown) {
        console.error(`[GetMemoriesTool] ❌ Error:`, error);
        throw error;
      }
    },
  };
}

/**
 * Creates a get_memories tool for Scrapybara SDK compatibility
 */
export function getMemoriesToolScrapybara(
  instance: UbuntuInstance,
  site_id: string,
  _user_id?: string,
  _instance_id?: string
) {
  return tool({
    name: 'get_memories',
    description:
      'Search and retrieve previously saved memories. Use when you need to recall user preferences, past research findings, decisions, or any information the user or assistant saved earlier. Optionally filter by client_id, project_id, or task_id to get context-specific memories.',
    parameters: z.object({
      search_query: z
        .string()
        .optional()
        .describe(
          'Optional search term to filter memories (searches in content, summary, and key).'
        ),
      type: z
        .string()
        .optional()
        .describe(
          'Optional memory type filter. Default is "assistant_note" for assistant-saved notes.'
        ),
      limit: z
        .number()
        .optional()
        .describe('Maximum number of memories to return. Default 10, max 50.'),
      client_id: z
        .string()
        .optional()
        .describe('Optional. Filter memories scoped to a specific client.'),
      project_id: z
        .string()
        .optional()
        .describe('Optional. Filter memories scoped to a specific project.'),
      task_id: z
        .string()
        .optional()
        .describe('Optional. Filter memories scoped to a specific task.'),
    }),
    execute: async (args) => {
      try {
        console.log(`[GetMemoriesTool-Scrapybara] 🔍 Retrieving memories`);
        console.log(`[GetMemoriesTool-Scrapybara] 🏢 Site ID: ${site_id}`);

        const agent = await findGrowthRobotAgent(site_id);
        if (!agent) {
          return {
            success: false,
            error: 'Memory tools require a Growth Robot agent for this site.',
            memories: [],
          };
        }

        const result = await getAgentMemories(agent.agentId, {
          search_query: args.search_query,
          type: args.type || 'assistant_note',
          limit: args.limit ?? 10,
          client_id: args.client_id,
          project_id: args.project_id,
          task_id: args.task_id,
        });

        if (!result.success) {
          return {
            success: false,
            error: result.error || 'Failed to retrieve memories',
            memories: [],
          };
        }

        const memories = (result.memories || []).map((m) => ({
          id: m.id,
          content: m.content,
          summary: m.summary,
          key: m.key,
          created_at: m.created_at,
        }));

        return {
          success: true,
          memories,
          count: memories.length,
          message:
            memories.length > 0
              ? `Found ${memories.length} memory(ies).`
              : 'No memories found matching the criteria.',
        };
      } catch (error: unknown) {
        console.error(`[GetMemoriesTool-Scrapybara] ❌ Error:`, error);
        throw error;
      }
    },
  });
}
