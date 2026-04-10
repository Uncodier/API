import { createRequirementStatusCore, listRequirementStatusCore } from './route';

export function requirementStatusTool(site_id: string, default_instance_id?: string) {
  return {
    name: 'requirement_status',
    description: 'Updates or lists the progress statuses of a client requirement. Use action="create" to save a new status, or action="list" to get the statuses for a given requirement. CRITICAL INSTRUCTION: If a requirement is created or you are asked to administer a requirement in an instance, you MUST add a status using this tool and provide the instance_id to link it to the current instance.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'list'], description: 'Action to perform. Default is "create"' },
        instance_id: { type: 'string', description: 'ID of the related instance (optional, use current instance_id if available)' },
        asset_id: { type: 'string', description: 'ID of the related asset (required for create)' },
        requirement_id: { type: 'string', description: 'ID of the requirement' },
        repo_url: { type: 'string', description: 'URL of the related repository (optional)' },
        preview_url: { type: 'string', description: 'Live preview or staging URL of the related asset (optional)' },
        source_code: { type: 'string', description: 'URL to a zip file containing the source code related to the requirement objective or preview (optional)' },
        status: { type: 'string', description: 'Progress status (e.g. in-progress, completed, failed) (required for create)' },
        message: { type: 'string', description: 'Message or detail of the progress' },
        cycle: { type: 'string', description: 'Specify the source of the work cycle. Set this to ensure an entire development cycle is performed for the requirement (can be null or a new numeric or text value)' },
        endpoint_url: { type: 'string', description: 'Automation endpoint for manual calling of the task, or automation' }
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
      source_code?: string;
      status?: string;
      message?: string;
      cycle?: string;
      endpoint_url?: string;
    }) => {
      const action = args.action || 'create';
      let effective_instance_id = args.instance_id || default_instance_id;
      
      // Prevent "default" from being passed as a UUID
      if (effective_instance_id === 'default') {
        effective_instance_id = undefined;
      }
      
      try {
        if (action === 'create') {
          if (!args.status) {
            throw new Error('status is required to create a requirement status');
          }
          
          const result = await createRequirementStatusCore({
            ...args,
            instance_id: effective_instance_id,
            site_id
          });
          return result;
        } else if (action === 'list') {
          const result = await listRequirementStatusCore({
            requirement_id: args.requirement_id,
            instance_id: effective_instance_id
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
