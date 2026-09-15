import { ComposioTools } from '@/lib/agentbase/services/composioTools';

export interface ComposioToolParams {
  action: 'search' | 'execute';
  search_intent?: string;
  action_name?: string;
  action_params?: Record<string, any>;
}

export function composioActionTool(siteId: string, apiKey: string) {
  return {
    name: 'use_composio_tools',
    description: 'Use this tool to search for available Composio actions and to execute them. If you need to perform an action on a third-party integration (e.g. GitHub, Slack, Gmail), first use action="search" with a search_intent. Then, use action="execute" providing the action_name and action_params found in the search results.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['search', 'execute'],
          description: 'Whether to search for available actions or execute a specific action.',
        },
        search_intent: {
          type: 'string',
          description: 'Required if action is "search". A phrase describing what you want to do (e.g., "send a slack message").',
        },
        action_name: {
          type: 'string',
          description: 'Required if action is "execute". The exact action name from the search results (e.g., "SLACK_SEND_MESSAGE").',
        },
        action_params: {
          type: 'object',
          description: 'Required if action is "execute". The parameters required by the action as indicated in the search results.',
        },
      },
      required: ['action'],
    },
    execute: async (args: ComposioToolParams) => {
      try {
        const composioTools = new ComposioTools({ apiKey, entityId: siteId });

        if (args.action === 'search') {
          if (!args.search_intent) {
            throw new Error('search_intent is required when action is "search"');
          }
          console.log(`[ComposioTool] 🔍 Searching for intent: ${args.search_intent}`);
          // Return the stringified representation of the tools
          const resultString = await composioTools.getToolsAsString({
            useCase: args.search_intent,
            useCaseLimit: 5
          });
          return {
            success: true,
            result: resultString,
            message: `Search completed for intent "${args.search_intent}". Check the 'result' field for available actions and their parameters.`
          };
        } else if (args.action === 'execute') {
          if (!args.action_name) {
            throw new Error('action_name is required when action is "execute"');
          }
          console.log(`[ComposioTool] 🚀 Executing action: ${args.action_name}`);
          const data = await composioTools.executeAction(args.action_name, args.action_params || {});
          return {
            success: true,
            result: data,
            message: `Successfully executed ${args.action_name}`
          };
        } else {
          throw new Error(`Unknown action: ${args.action}`);
        }
      } catch (error: any) {
        console.error(`[ComposioTool] ❌ Error in composioActionTool:`, error.message);
        throw error;
      }
    },
  };
}
