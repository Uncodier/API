/**
 * Assistant Protocol Wrapper for Save on Memory Tool
 * Persists notes and findings to agent_memories for later retrieval
 */

import { tool } from 'scrapybara/tools';
import { z } from 'zod';
import type { UbuntuInstance } from 'scrapybara';
import { findGrowthRobotAgent } from '@/lib/helpers/agent-finder';
import { saveOnAgentMemory } from '@/lib/services/agent-memory-tools-service';

export interface SaveOnMemoryToolParams {
  content: string;
  key?: string;
  client_id?: string;
  project_id?: string;
  task_id?: string;
}

/**
 * Creates a save_on_memory tool for OpenAI/assistant compatibility
 * @param site_id - The site ID
 * @param user_id - The user ID
 * @param instance_id - Optional instance ID for context
 */
export function saveOnMemoryTool(site_id: string, user_id: string, instance_id?: string) {
  return {
    name: 'save_on_memory',
    description:
      'Save important information, findings, or notes to memory for later retrieval. Use when the user shares preferences, decisions, research findings, or any information worth remembering. Optionally scope by client_id, project_id, or task_id when the context refers to a specific client, project, or task.',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The content to save. Be concise but include all relevant details.',
        },
        key: {
          type: 'string',
          description:
            'Optional categorization key to help find this memory later (e.g. "user_preferences", "research_topic").',
        },
        client_id: {
          type: 'string',
          description: 'Optional. Scope this memory to a specific client when context involves a client.',
        },
        project_id: {
          type: 'string',
          description: 'Optional. Scope this memory to a specific project when context involves a project.',
        },
        task_id: {
          type: 'string',
          description: 'Optional. Scope this memory to a specific task when context involves a task.',
        },
      },
      required: ['content'],
    },
    execute: async (args: SaveOnMemoryToolParams) => {
      try {
        console.log(`[SaveOnMemoryTool] 💾 Saving to memory`);
        console.log(`[SaveOnMemoryTool] 🏢 Site ID: ${site_id}`);

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
        console.error(`[SaveOnMemoryTool] ❌ Error:`, error);
        throw error;
      }
    },
  };
}

/**
 * Creates a save_on_memory tool for Scrapybara SDK compatibility
 */
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
        console.log(`[SaveOnMemoryTool-Scrapybara] 💾 Saving to memory`);
        console.log(`[SaveOnMemoryTool-Scrapybara] 🏢 Site ID: ${site_id}`);

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
