// Shared email templates for task notifications

export function generateTaskTeamEmailHtml(params: {
  recipientName: string;
  taskTitle: string;
  taskDescription?: string;
  taskType: string;
  priority: number;
  leadName?: string;
  leadEmail?: string;
  assigneeName?: string;
  assigneeEmail?: string;
  scheduledDate?: string;
  taskUrl: string;
  agentName?: string;
}): string {
  const priorityConfig = {
    0: { color: '#10b981', bg: '#ecfdf5', label: 'Low' },
    1: { color: '#3b82f6', bg: '#eff6ff', label: 'Normal' },
    2: { color: '#f59e0b', bg: '#fffbeb', label: 'High' },
    3: { color: '#ef4444', bg: '#fef2f2', label: 'Urgent' }
  } as const;

  const key = (Math.min(params.priority, 3) as 0 | 1 | 2 | 3);
  const priority = priorityConfig[key] || priorityConfig[1];
  const hasLeadInfo = params.leadName || params.leadEmail;

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>New Task Assigned</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f8fafc; line-height: 1.6;">
      <div style="max-width: 600px; margin: 40px auto; background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); overflow: hidden;">
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 32px 40px; text-align: center;">
          <div style="display: inline-block; background-color: rgba(255, 255, 255, 0.1); border-radius: 50%; padding: 12px; margin-bottom: 16px;">
            <div style="width: 24px; height: 24px; background-color: #ffffff; border-radius: 4px; position: relative;">
              <div style="position: absolute; top: 6px; left: 6px; width: 12px; height: 8px; border: 2px solid #667eea; border-top: none; border-right: none; transform: rotate(-45deg);"></div>
            </div>
          </div>
          <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 600; letter-spacing: -0.025em;">New Task Assigned</h1>
          <p style="margin: 8px 0 0; color: rgba(255, 255, 255, 0.9); font-size: 16px; font-weight: 400;">A new task has been created and assigned</p>
        </div>
        <div style="padding: 40px;">
          <div style="margin-bottom: 32px;">
            <div style="display: inline-block; background-color: ${priority.bg}; color: ${priority.color}; padding: 8px 16px; border-radius: 20px; font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;">
              ${priority.label} Priority
            </div>
          </div>
          <div style="margin-bottom: 32px;">
            <p style="margin: 0 0 16px; font-size: 18px; color: #1e293b; font-weight: 500;">
              Hi ${params.recipientName},
            </p>
            <p style="margin: 0 0 16px; font-size: 16px; color: #475569;">
              ${params.agentName ? `${params.agentName} has` : 'A'} created a new task.
            </p>
            <div style="background-color: #f8fafc; border-left: 4px solid #667eea; padding: 20px 24px; border-radius: 0 8px 8px 0; margin: 24px 0;">
              <h3 style="margin: 0 0 8px; font-size: 18px; color: #1e293b; font-weight: 600;">
                ${params.taskTitle}
              </h3>
              ${params.taskDescription ? `<p style="margin: 0; font-size: 15px; color: #475569; line-height: 1.6;">${params.taskDescription}</p>` : ''}
            </div>
          </div>
          <div style="margin-bottom: 32px;">
            <h3 style="margin: 0 0 16px; font-size: 18px; color: #1e293b; font-weight: 600;">Task Details</h3>
            <div style="background-color: #f1f5f9; padding: 20px 24px; border-radius: 8px; border: 1px solid #e2e8f0;">
              <div style="margin-bottom: 12px;">
                <span style="display: inline-block; font-weight: 600; color: #1e293b; min-width: 80px;">Type:</span>
                <span style="color: #475569; font-size: 15px;">${params.taskType}</span>
              </div>
              ${params.scheduledDate ? `<div><span style="display: inline-block; font-weight: 600; color: #1e293b; min-width: 80px;">Due:</span> <span style="color: #475569; font-size: 15px;">${new Date(params.scheduledDate).toLocaleDateString('en-US', {weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit'})}</span></div>` : ''}
            </div>
          </div>
          ${hasLeadInfo ? `<div style="margin-bottom: 32px;"><h3 style="margin: 0 0 16px; font-size: 18px; color: #1e293b; font-weight: 600;">Related Lead</h3><div style="background-color: #eff6ff; padding: 20px 24px; border-radius: 8px; border: 1px solid #bfdbfe;">${params.leadName ? `<div style=\"margin-bottom: 12px;\"><span style=\"display: inline-block; font-weight: 600; color: #1e40af; min-width: 60px;\">Name:</span> <span style=\"color: #1e293b; font-size: 15px;\">${params.leadName}</span></div>` : ''}${params.leadEmail ? `<div><span style=\"display: inline-block; font-weight: 600; color: #1e40af; min-width: 60px;\">Email:</span> <a href=\"mailto:${params.leadEmail}\" style=\"color: #3b82f6; text-decoration: none; font-size: 15px; border-bottom: 1px solid transparent; transition: border-color 0.2s;\">${params.leadEmail}</a></div>` : ''}</div></div>` : ''}
          <div style="text-align: center; margin: 40px 0 32px;">
            <a href="${params.taskUrl}" style="display: inline-block; background-color: #667eea; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; box-shadow: 0 2px 4px rgba(102, 126, 234, 0.2);">View Task Details</a>
          </div>
          <div style="text-align: center; padding: 24px 0; border-top: 1px solid #e5e7eb;">
            <p style="margin: 0; color: #9ca3af; font-size: 14px;">This email was sent automatically by the Uncodie task management system.</p>
          </div>
        </div>
      </div>
    </body>
    </html>
  `;
}

export async function generateTaskUserNotificationHtml(params: {
  taskId: string;
  taskTitle: string;
  taskDescription?: string;
  taskType: string;
  priority: number;
  leadName?: string;
  leadEmail?: string;
  assigneeName?: string;
  assigneeEmail?: string;
  scheduledDate?: string;
  taskUrl: string;
}): Promise<string> {
  const priorityConfig = {
    0: { color: '#6b7280', bg: '#f9fafb', label: 'Low' },
    1: { color: '#3b82f6', bg: '#eff6ff', label: 'Normal' },
    2: { color: '#f59e0b', bg: '#fffbeb', label: 'High' },
    3: { color: '#ef4444', bg: '#fef2f2', label: 'Urgent' }
  } as const;
  const key = (Math.min(params.priority, 3) as 0 | 1 | 2 | 3);
  const priority = priorityConfig[key] || priorityConfig[1];

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>New Task Created</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f8fafc; line-height: 1.6;">
      <div style="max-width: 600px; margin: 40px auto; background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); overflow: hidden;">
        <div style="background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%); padding: 32px 40px; text-align: center;">
          <div style="display: inline-block; background-color: rgba(255, 255, 255, 0.1); border-radius: 50%; padding: 12px; margin-bottom: 16px;">
            <div style="width: 24px; height: 24px; background-color: #ffffff; border-radius: 4px; position: relative;">
              <div style="position: absolute; top: 6px; left: 6px; width: 12px; height: 8px; border: 2px solid #6366f1; border-top: none; border-right: none; transform: rotate(-45deg);"></div>
            </div>
          </div>
          <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 600; letter-spacing: -0.025em;">New Task Created</h1>
          <p style="margin: 8px 0 0; color: rgba(255, 255, 255, 0.9); font-size: 16px; font-weight: 400;">A new task has been added to the system</p>
        </div>
        <div style="padding: 40px;">
          <div style="margin-bottom: 32px; background-color: #f9fafb; border-radius: 12px; padding: 24px; border: 1px solid #e5e7eb;">
            <h2 style="margin: 0 0 16px; font-size: 20px; color: #111827; font-weight: 600;">${params.taskTitle}</h2>
            ${params.taskDescription ? `<div style=\"margin-bottom: 20px;\"><p style=\"margin: 0; font-size: 15px; color: #6b7280; line-height: 1.6;\">${params.taskDescription}</p></div>` : ''}
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 20px;">
              <div>
                <span style="display: block; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase; margin-bottom: 4px;">Task Type</span>
                <span style="font-size: 14px; color: #111827; font-weight: 500;">${params.taskType}</span>
              </div>
              <div>
                <span style="display: block; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase; margin-bottom: 4px;">Priority</span>
                <span style="display: inline-block; background-color: ${priority.bg}; color: ${priority.color}; padding: 4px 8px; border-radius: 6px; font-size: 12px; font-weight: 600;">${priority.label}</span>
              </div>
            </div>
            ${params.scheduledDate ? `<div style=\"margin-top: 16px;\"><span style=\"display: block; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase; margin-bottom: 4px;\">Scheduled Date</span> <span style=\"font-size: 14px; color: #111827; font-weight: 500;\">${new Date(params.scheduledDate).toLocaleDateString('en-US', {weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit'})}</span></div>` : ''}
          </div>
          ${params.assigneeName || params.assigneeEmail ? `<div style=\"margin-bottom: 32px;\"><h3 style=\"margin: 0 0 16px; font-size: 18px; color: #1e293b; font-weight: 600;\">Assigned To</h3><div style=\"background-color: #ecfdf5; padding: 20px 24px; border-radius: 8px; border: 1px solid #a7f3d0;\">${params.assigneeName ? `<div style=\\\"margin-bottom: 12px;\\\"><span style=\\\"display: inline-block; font-weight: 600; color: #065f46; min-width: 60px;\\\">Name:</span> <span style=\\\"color: #1e293b; font-size: 15px;\\\">${params.assigneeName}</span></div>` : ''}${params.assigneeEmail ? `<div><span style=\\\"display: inline-block; font-weight: 600; color: #065f46; min-width: 60px;\\\">Email:</span> <a href=\\\"mailto:${params.assigneeEmail}\\\" style=\\\"color: #10b981; text-decoration: none; font-size: 15px;\\\">${params.assigneeEmail}</a></div>` : ''}</div></div>` : ''}
          ${params.leadName || params.leadEmail ? `<div style=\"margin-bottom: 32px;\"><h3 style=\"margin: 0 0 16px; font-size: 18px; color: #1e293b; font-weight: 600;\">Related Lead</h3><div style=\"background-color: #eff6ff; padding: 20px 24px; border-radius: 8px; border: 1px solid #bfdbfe;\">${params.leadName ? `<div style=\\\"margin-bottom: 12px;\\\"><span style=\\\"display: inline-block; font-weight: 600; color: #1e40af; min-width: 60px;\\\">Name:</span> <span style=\\\"color: #1e293b; font-size: 15px;\\\">${params.leadName}</span></div>` : ''}${params.leadEmail ? `<div><span style=\\\"display: inline-block; font-weight: 600; color: #1e40af; min-width: 60px;\\\">Email:</span> <a href=\\\"mailto:${params.leadEmail}\\\" style=\\\"color: #3b82f6; text-decoration: none; font-size: 15px;\\\">${params.leadEmail}</a></div>` : ''}</div></div>` : ''}
          <div style="text-align: center; margin: 40px 0 32px;">
            <a href="${params.taskUrl}" style="display: inline-block; background-color: #6366f1; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; box-shadow: 0 2px 4px rgba(99, 102, 241, 0.2);">View Task Details</a>
          </div>
          <div style="text-align: center; padding: 24px 0; border-top: 1px solid #e5e7eb;">
            <p style="margin: 0; color: #9ca3af; font-size: 14px;">This email was sent automatically by the Uncodie task management system.</p>
          </div>
        </div>
      </div>
    </body>
    </html>
  `;
}


