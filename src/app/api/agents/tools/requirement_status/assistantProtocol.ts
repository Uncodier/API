import { createRequirementStatusCore, listRequirementStatusCore } from './route';

export function requirementStatusTool(site_id: string) {
  return {
    name: 'requirement_status',
    description: 'Updates or lists the progress statuses of a client requirement. Use action="create" to save a new status, or action="list" to get the statuses for a given requirement.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'list'], description: 'Action to perform. Default is "create"' },
        instance_id: { type: 'string', description: 'ID of the related instance (optional for list)' },
        asset_id: { type: 'string', description: 'ID of the related asset (required for create)' },
        requirement_id: { type: 'string', description: 'ID of the requirement' },
        repo_url: { type: 'string', description: 'URL of the related repository (optional)' },
        preview_url: { type: 'string', description: 'Live preview or staging URL of the related asset (optional)' },
        status: { type: 'string', description: 'Progress status (e.g. in-progress, completed, failed) (required for create)' },
        message: { type: 'string', description: 'Message or detail of the progress' }
      },
      required: ['requirement_id']
    },
    execute: async (args: {
      action?: 'create' | 'list';
      instance_id?: string;
      asset_id?: string;
      requirement_id: string;
      repo_url?: string;
      preview_url?: string;
      status?: string;
      message?: string;
    }) => {
      const action = args.action || 'create';
      
      try {
        if (action === 'create') {
          if (!args.instance_id || !args.status) {
            throw new Error('instance_id and status are required to create a requirement status');
          }
          
          const result = await createRequirementStatusCore({
            ...args,
            site_id
          });
          return result;
        } else if (action === 'list') {
          const result = await listRequirementStatusCore({
            requirement_id: args.requirement_id,
            instance_id: args.instance_id
          });
          return result;
        }
        
        throw new Error(`Invalid action: ${action}`);
      } catch (error: any) {
        throw new Error(error.message || `Failed to execute requirement_status tool for action ${action}`);
      }
    }
  };
}
