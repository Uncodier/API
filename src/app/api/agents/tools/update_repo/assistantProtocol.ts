import { updateRepoCore } from './core';

export interface UpdateRepoToolParams {
  action: 'execute';
  requirement_id: string;
  instruction: string;
}

export function updateRepoTool(site_id: string, instance_id: string, user_id?: string) {
  return {
    name: 'update_repo',
    description: 'Execute a simple instruction directly on a requirement\'s repository without needing a complex instance_plan. Triggers a background workflow that creates a sandbox, executes the instruction, and pushes the changes. Use this when the request is straightforward, the repository already exists, and doesn\'t require multiple steps or deep planning (e.g. "add a button to the nav menu", "change the title text").',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['execute'],
          description: 'The action to perform (always "execute").'
        },
        requirement_id: {
          type: 'string',
          description: 'The UUID of the requirement whose repository you want to update.'
        },
        instruction: {
          type: 'string',
          description: 'A clear, detailed instruction of what needs to be changed in the repository. The agent will read this to perform the update.'
        }
      },
      required: ['action', 'requirement_id', 'instruction'],
    },
    execute: async (args: UpdateRepoToolParams) => {
      try {
        console.log(`[UpdateRepoTool] 🔧 Executing update_repo for requirement: ${args.requirement_id}`);
        
        if (!site_id || !instance_id) {
          throw new Error('Missing required site_id or instance_id context');
        }

        return await updateRepoCore({
          site_id,
          instance_id,
          user_id: user_id || '',
          requirement_id: args.requirement_id,
          instruction: args.instruction
        });
      } catch (error: any) {
        console.error(`[UpdateRepoTool] ❌ Error executing tool:`, error);
        return { success: false, error: error.message || String(error) };
      }
    },
  };
}
