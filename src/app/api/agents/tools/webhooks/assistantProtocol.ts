import { getMakinariClient } from './client';

export interface WebhooksToolParams {
  action: 'list' | 'create';
  url?: string;
  events?: string[];
}

export const webhooksTool = () => {
  return {
    name: 'webhooks',
    description: 'Manage webhooks. Use action="list" to get all webhooks. Use action="create" with url and events (array of strings) to register a new webhook.',
    parameters: {
      type: 'object',
      properties: {
        action: { 
          type: 'string', 
          enum: ['list', 'create'],
          description: 'Action to perform: "list" to get webhooks, "create" to register a new one.'
        },
        url: { 
          type: 'string', 
          description: 'The URL for the webhook (required for create action).' 
        },
        events: { 
          type: 'array', 
          items: { type: 'string' },
          description: 'List of events to subscribe to (required for create action).' 
        }
      },
      required: ['action']
    },
    execute: async (args: WebhooksToolParams) => {
      try {
        const client = getMakinariClient();
        
        if (args.action === 'list') {
          const webhooks = await client.getWebhooks();
          return { success: true, webhooks };
        }
        
        if (args.action === 'create') {
          if (!args.url || !args.events || args.events.length === 0) {
            return { 
              success: false, 
              error: 'URL and at least one event are required for creating a webhook.' 
            };
          }
          const webhook = await client.createWebhook(args.url, args.events);
          return { success: true, webhook };
        }

        return { success: false, error: 'Invalid action. Supported actions: list, create.' };
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    }
  };
};
