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
      status?: string;
      message?: string;
    }) => {
      const baseUrl = (process.env.NEXT_PUBLIC_API_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000').replace(/\/$/, '');
      const action = args.action || 'create';
      
      if (action === 'create') {
        if (!args.instance_id || !args.asset_id || !args.status) {
          throw new Error('instance_id, asset_id, and status are required to create a requirement status');
        }
        const res = await fetch(`${baseUrl}/api/agents/tools/requirement_status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...args,
            site_id
          })
        });

        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || 'Failed to update requirement status');
        }
        return data;
      } else if (action === 'list') {
        const url = new URL(`${baseUrl}/api/agents/tools/requirement_status`);
        url.searchParams.append('requirement_id', args.requirement_id);
        if (args.instance_id) {
          url.searchParams.append('instance_id', args.instance_id);
        }
        
        const res = await fetch(url.toString(), {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' }
        });

        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || 'Failed to list requirement status');
        }
        return data;
      }
      
      throw new Error(`Invalid action: ${action}`);
    }
  };
}
