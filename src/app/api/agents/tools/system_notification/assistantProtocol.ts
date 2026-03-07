export function systemNotificationTool(site_id: string) {
  return {
    name: 'system_notification',
    description: 'List team members or send a notification to a specific team member. Set action to "list" to list available team members. Set action to "notify" to send a notification (requires team_member_email, title, message; instance_id is optional but highly recommended). If they are registered and have a phone number, it is sent via WhatsApp and in-app; otherwise, it sends an email.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'notify'], description: 'Action to perform. "list" returns team members, "notify" sends a notification' },
        team_member_email: { type: 'string', description: 'Email address of the team member to notify (required for notify action)' },
        instance_id: { type: 'string', description: 'Instance ID to link in the notification (optional for notify action, but highly recommended)' },
        title: { type: 'string', description: 'Title of the notification (required for notify action)' },
        message: { type: 'string', description: 'Content of the message to notify (required for notify action)' }
      },
      required: ['action']
    },
    execute: async (args: {
      action: 'list' | 'notify';
      team_member_email?: string;
      instance_id?: string;
      title?: string;
      message?: string;
    }) => {
      const baseUrl = process.env.NEXT_PUBLIC_API_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
      
      const res = await fetch(`${baseUrl}/api/agents/tools/system_notification`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...args,
          site_id
        })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to execute system notification tool');
      }

      return data;
    }
  };
}
