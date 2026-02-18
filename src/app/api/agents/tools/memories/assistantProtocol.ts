/**
 * Assistant Protocol Wrapper for Memories Tool
 * Unified tool for managing memories (save, list)
 * Includes Scrapybara variants for save_on_memory and get_memories
 */

import { tool } from 'scrapybara/tools';
import { z } from 'zod';
import type { UbuntuInstance } from 'scrapybara';
import { getAgentMemories, saveOnAgentMemory } from '@/lib/services/agent-memory-tools-service';
import { findGrowthRobotAgent } from '@/lib/helpers/agent-finder';
import { getMemoriesCore } from './get/route';

function getApiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}

export interface MemoriesToolParams {
  action: 'save' | 'list' | 'update' | 'delete';
  
  // Save params
  content?: string; // Required for save, optional for update
  key?: string;
  
  // Update/Delete params
  memory_id?: string; // Required for update/delete
  
  // List params
  search_query?: string;
  type?: string;
  limit?: number;
  
  // Common context params
  client_id?: string;
  project_id?: string;
  task_id?: string;
  
  // Internal params injected by wrapper
  site_id?: string;
  user_id?: string;
  instance_id?: string;
}

export function memoriesTool(site_id: string, user_id: string, instance_id?: string) {
  return {
    name: 'memories',
    description:
      'Manage agent memories. Actions: "save" (create new), "list" (search/filter), "update" (modify existing), "delete" (remove).',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['save', 'list', 'update', 'delete'],
          description: 'Action to perform on memories.'
        },
        // Save/Update params
        content: {
          type: 'string',
          description: 'The content to save or update. Required for "save", optional for "update".',
        },
        key: {
          type: 'string',
          description: 'Optional categorization key (e.g. "user_preferences"). used in save/update.',
        },
        memory_id: {
          type: 'string',
          description: 'The ID of the memory to update or delete. Required for "update" and "delete" actions.',
        },
        
        // List params
        search_query: {
          type: 'string',
          description: 'Optional search term to filter memories (searches in content, summary, and key).',
        },
        type: {
          type: 'string',
          description: 'Optional memory type filter. Default is "assistant_note".',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of memories to return. Default 10.',
        },
        
        // Context params
        client_id: {
          type: 'string',
          description: 'Optional. Scope to a specific client.',
        },
        project_id: {
          type: 'string',
          description: 'Optional. Scope to a specific project.',
        },
        task_id: {
          type: 'string',
          description: 'Optional. Scope to a specific task.',
        },
      },
      required: ['action'],
    },
    execute: async (args: MemoriesToolParams) => {
      const { action, ...params } = args;

      try {
        console.log(`[MemoriesTool] 🧠 Action: ${action}`);
        console.log(`[MemoriesTool] 🏢 Site ID: ${site_id}`);

        const agent = await findGrowthRobotAgent(site_id);
        if (!agent) {
          return {
            success: false,
            error: 'Memory tools require a Growth Robot agent for this site.',
          };
        }

        if (action === 'save') {
          if (!params.content) {
            throw new Error('Missing required field for save memory: content');
          }

          const body = {
            ...params,
            agent_id: agent.agentId,
            user_id: agent.userId,
            instance_id,
            site_id,
          };

          const res = await fetch(`${getApiBaseUrl()}/api/agents/tools/memories/save`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });

          const data = await res.json();
          if (!res.ok) {
            throw new Error(data.error || 'Save memory failed');
          }
          return data;
        }

        if (action === 'update') {
          if (!params.memory_id) {
            throw new Error('Missing required field for update memory: memory_id');
          }

          const body = {
            ...params,
            agent_id: agent.agentId,
            site_id,
          };

          const res = await fetch(`${getApiBaseUrl()}/api/agents/tools/memories/update`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });

          const data = await res.json();
          if (!res.ok) {
            throw new Error(data.error || 'Update memory failed');
          }
          return data;
        }

        if (action === 'delete') {
          if (!params.memory_id) {
            throw new Error('Missing required field for delete memory: memory_id');
          }

          const body = {
            memory_id: params.memory_id,
            agent_id: agent.agentId,
            site_id,
          };

          const res = await fetch(`${getApiBaseUrl()}/api/agents/tools/memories/delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });

          const data = await res.json();
          if (!res.ok) {
            throw new Error(data.error || 'Delete memory failed');
          }
          return data;
        }

        if (action === 'list') {
          const filters = {
            ...params,
            agent_id: agent.agentId,
            instance_id,
            site_id,
          };
          
          const result = await getMemoriesCore(filters);
          
          const memories = (result.data.memories || []).map((m: any) => ({
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
        }

        throw new Error(`Invalid action: ${action}`);
      } catch (error: unknown) {
        console.error(`[MemoriesTool] ❌ Error:`, error);
        throw error;
      }
    },
  };
}

/** Scrapybara variant: save_on_memory (used when expanding memories tool) */
export function saveOnMemoryToolScrapybara(
  instance: UbuntuInstance,
  site_id: string,
  user_id: string,
  instance_id?: string
) {
  return tool({
    name: 'save_on_memory',
    description:
      'Save important information, findings, or notes to memory for later retrieval. Use when the user shares preferences, decisions, research findings, or any information worth remembering. Optionally scope by client_id, project_id, or task_id when the context refers to a specific client, project, or task.',
    parameters: z.object({
      content: z.string().describe('The content to save. Be concise but include all relevant details.'),
      key: z
        .string()
        .optional()
        .describe(
          'Optional categorization key to help find this memory later (e.g. "user_preferences", "research_topic").'
        ),
      client_id: z
        .string()
        .optional()
        .describe('Optional. Scope this memory to a specific client when context involves a client.'),
      project_id: z
        .string()
        .optional()
        .describe('Optional. Scope this memory to a specific project when context involves a project.'),
      task_id: z
        .string()
        .optional()
        .describe('Optional. Scope this memory to a specific task when context involves a task.'),
    }),
    execute: async (args) => {
      try {
        const agent = await findGrowthRobotAgent(site_id);
        if (!agent) {
          return {
            success: false,
            error: 'Memory tools require a Growth Robot agent for this site.',
          };
        }

        const result = await saveOnAgentMemory(agent.agentId, agent.userId, args.content, {
          key: args.key,
          instance_id,
          client_id: args.client_id,
          project_id: args.project_id,
          task_id: args.task_id,
        });

        if (!result.success) {
          return {
            success: false,
            error: result.error || 'Failed to save memory',
          };
        }

        return {
          success: true,
          memoryId: result.memoryId,
          message: 'Information saved to memory successfully.',
        };
      } catch (error: unknown) {
        console.error(`[SaveOnMemoryTool-Scrapybara] ❌ Error:`, error);
        throw error;
      }
    },
  });
}

/** Scrapybara variant: get_memories (used when expanding memories tool) */
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
