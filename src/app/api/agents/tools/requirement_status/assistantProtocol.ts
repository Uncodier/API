import {
  createRequirementStatusCore,
  listRequirementStatusCore,
} from '@/lib/tools/requirement-status-core';

export function requirementStatusTool(site_id: string, default_instance_id?: string, options: { readOnly?: boolean } = {}) {
  const tool = {
    name: 'requirement_status',
    description:
      'Updates or lists the progress statuses of a client requirement. Use action="create" to save a new status, or action="list" to get the statuses for a given requirement. CRITICAL INSTRUCTION: If a requirement is created or you are asked to administer a requirement in an instance, you MUST add a status using this tool and provide the instance_id to link it to the current instance. ' +
      'ASSET_ID RULE: asset_id must be the UUID of an existing row in the assets table when you link this status to a concrete asset. It is NOT the same as requirement_id—never copy requirement_id into asset_id; that causes a database foreign-key error. If no asset applies or you only have the requirement id, omit asset_id entirely.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'list'], description: 'Action to perform. Default is "create"' },
        instance_id: { type: 'string', description: 'ID of the related instance (optional, use current instance_id if available)' },
        asset_id: {
          type: 'string',
          description:
            'Optional. UUID of a related asset that already exists in the assets table. Do not set this to requirement_id—they are different entities. Omit when there is no asset or you do not have a valid assets.id from context.',
        },
        requirement_id: { type: 'string', description: 'ID of the requirement' },
        repo_url: { type: 'string', description: 'URL of the related repository (optional)' },
        preview_url: { type: 'string', description: 'Live preview or staging URL of the related asset (optional)' },
        source_code: { type: 'string', description: 'URL to a zip file containing the source code related to the requirement objective or preview (optional)' },
        stage: { type: 'string', description: 'Progress stage (e.g. in-progress, completed, failed) (required for create)' },
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
      stage?: string;
      message?: string;
      cycle?: string;
      endpoint_url?: string;
    }) => {
      const action = args.action || (options.readOnly ? 'list' : 'create');
      if (options.readOnly && action !== 'list') {
        throw new Error('requirement_status is read-only in conversations. The requirements update receipt is already persisted; do not create another status or resubmit the command.');
      }
      // A conversation may inspect a requirement executed by another instance.
      // Do not silently filter its history to the requesting session.
      let effective_instance_id = args.instance_id || (options.readOnly ? undefined : default_instance_id);
      
      // Prevent "default" from being passed as a UUID
      if (effective_instance_id === 'default') {
        effective_instance_id = undefined;
      }
      
      try {
        if (action === 'create') {
          if (!args.stage) {
            throw new Error('stage is required to create a requirement status');
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
  if (!options.readOnly) return tool;
  return {
    ...tool,
    description: 'Read-only requirement execution history. Only action="list" is available in conversations. A successful requirements action="update" already persists the command and its authorization receipt; do not create a status to link this session, record queued work, or reopen execution. A rejected status write does not cancel a saved command. Use the returned command receipt to report queued work honestly; do not resubmit it.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list'], description: 'Read execution history. Default is list; create is unavailable.' },
        requirement_id: { type: 'string', description: 'ID of the requirement to inspect' },
        instance_id: { type: 'string', description: 'Optional explicit filter by execution instance. Omit to read all statuses for this requirement.' },
      },
      required: ['requirement_id'],
    },
  };
}
