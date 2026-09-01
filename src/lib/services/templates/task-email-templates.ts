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
  <meta name="color-scheme" content="light only" />
  <meta name="supported-color-schemes" content="light" />
<style type="text/css">
        :root { color-scheme: light only; }

    .email-header {
      background-color: #1e1e2d !important;
      background-image: linear-gradient(#1e1e2d, #1e1e2d) !important;
    }
    .email-header-title,
    .email-header h1 {
      color: #f0f0f5 !important;
      -webkit-text-fill-color: #f0f0f5 !important;
    }
    .email-header-sub,
    .email-header p {
      color: #a1a1aa !important;
      -webkit-text-fill-color: #a1a1aa !important;
    }

    .email-card {
      background-color: #ffffff !important;
      background-image: linear-gradient(#ffffff, #ffffff) !important;
      color: #111111 !important;
    }

    .email-heading {
      color: #111111 !important;
      -webkit-text-fill-color: #111111 !important;
    }
    .email-text {
      color: #111111 !important;
      -webkit-text-fill-color: #111111 !important;
    }
    .email-muted,
    .email-subtle {
      color: #52525b !important;
      -webkit-text-fill-color: #52525b !important;
    }

    .email-panel {
      background-color: #f0f0f5 !important;
      background-image: linear-gradient(#f0f0f5, #f0f0f5) !important;
      border: 1px solid #e4e4e7 !important;
      color: #111111 !important;
    }
    .email-panel,
    .email-panel .email-text,
    .email-panel .email-heading,
    .email-panel div,
    .email-panel p,
    .email-panel span:not(.email-badge):not(.email-cta-label),
    .email-panel strong {
      color: #111111 !important;
      -webkit-text-fill-color: #111111 !important;
    }

    .email-code-box {
      background-color: #f4ffe5 !important;
      background-image: linear-gradient(#f4ffe5, #f4ffe5) !important;
      border: 1px solid #c6f08a !important;
    }
    .email-code-label {
      color: #3f6212 !important;
      -webkit-text-fill-color: #3f6212 !important;
    }
    .email-code-value {
      color: #111111 !important;
      -webkit-text-fill-color: #111111 !important;
    }

    .email-label {
      color: #3f6212 !important;
      -webkit-text-fill-color: #3f6212 !important;
      font-weight: 600 !important;
    }

    .email-badge {
      display: inline-block !important;
      background-color: #90ff17 !important;
      background-image: linear-gradient(#90ff17, #90ff17) !important;
      box-shadow: inset 0 0 0 999px #90ff17 !important;
      color: #000000 !important;
      -webkit-text-fill-color: #000000 !important;
      border: 0 !important;
    }

    .email-link {
      color: #000000 !important;
      -webkit-text-fill-color: #000000 !important;
    }

    .email-cta-td {
      background-color: #000000 !important;
      background-image: linear-gradient(#000000, #000000) !important;
      box-shadow: inset 0 0 0 999px #000000 !important;
    }
    .email-cta {
      background-color: #000000 !important;
      background-image: linear-gradient(#000000, #000000) !important;
      box-shadow: inset 0 0 0 999px #000000 !important;
      color: #ffffff !important;
      -webkit-text-fill-color: #ffffff !important;
      border: 0 !important;
    }
    .email-cta-label,
    .email-cta span {
      color: #ffffff !important;
      -webkit-text-fill-color: #ffffff !important;
    }
        
</style>
      <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>New Task Assigned</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f8fafc; line-height: 1.6;">
      <div class="email-card" style="max-width: 600px; margin: 40px auto; background-color: #fafafa; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); overflow: hidden;">
        <div class="email-header" style="background: #1e1e2d; padding: 32px 40px; text-align: center;">
          <div style="display: inline-block; background-color: rgba(255, 255, 255, 0.1); border-radius: 50%; padding: 12px; margin-bottom: 16px;">
            <div style="width: 24px; height: 24px; background-color: #ffffff; border-radius: 4px; position: relative;">
              <div style="position: absolute; top: 6px; left: 6px; width: 12px; height: 8px; border: 2px solid #000000; border-top: none; border-right: none; transform: rotate(-45deg);"></div>
            </div>
          </div>
          <h1 style="margin: 0; color: #f0f0f5; font-size: 24px; font-weight: 600; letter-spacing: -0.025em;">New Task Assigned</h1>
          <p style="margin: 8px 0 0; color: #a1a1aa; font-size: 16px; font-weight: 400;">A new task has been created and assigned</p>
        </div>
        <div style="padding: 40px;">
          <div style="margin-bottom: 32px;">
            <div class="email-badge" style="display: inline-block; background-color: ${priority.bg}; color: ${priority.color}; padding: 8px 16px; border-radius: 20px; font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;">
              ${priority.label} Priority
            </div>
          </div>
          <div style="margin-bottom: 32px;">
            <p class="email-text" style="margin: 0 0 16px; font-size: 18px; color: #111111; font-weight: 500;">
              Hi ${params.recipientName},
            </p>
            <p class="email-text" style="margin: 0 0 16px; font-size: 16px; color: #111111;">
              ${params.agentName ? `${params.agentName} has` : 'A'} created a new task.
            </p>
            <div class="email-panel" style="background-color: #f0f0f5; border-left: 4px solid #90ff17; padding: 20px 24px; border-radius: 0 8px 8px 0; margin: 24px 0;">
              <h3 class="email-heading" style="margin: 0 0 8px; font-size: 18px; color: #111111; font-weight: 600;">
                ${params.taskTitle}
              </h3>
              ${params.taskDescription ? `<p class="email-text" style="margin: 0; font-size: 15px; color: #111111; line-height: 1.6;">${params.taskDescription}</p>` : ''}
            </div>
          </div>
          <div style="margin-bottom: 32px;">
            <h3 class="email-heading" style="margin: 0 0 16px; font-size: 18px; color: #111111; font-weight: 600;">Task Details</h3>
            <div class="email-panel" style="background-color: #f0f0f5; padding: 20px 24px; border-radius: 8px; border: 1px solid #e4e4e7;">
              <div style="margin-bottom: 12px;">
                <span class="email-text" style="display: inline-block; font-weight: 600; color: #111111; min-width: 80px;">Type:</span>
                <span class="email-text" style="color: #111111; font-size: 15px;">${params.taskType}</span>
              </div>
              ${params.scheduledDate ? `<div><span class="email-text" style="display: inline-block; font-weight: 600; color: #111111; min-width: 80px;">Due:</span> <span class="email-text" style="color: #111111; font-size: 15px;">${new Date(params.scheduledDate).toLocaleDateString((params as any).locale === 'es' ? 'es-ES' : (params as any).locale === 'fr' ? 'fr-FR' : (params as any).locale === 'de' ? 'de-DE' : (params as any).locale === 'ja' ? 'ja-JP' : 'en-US', {weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit'})}</span></div>` : ''}
            </div>
          </div>
          ${hasLeadInfo ? `<div style="margin-bottom: 32px;"><h3 class="email-heading" style="margin: 0 0 16px; font-size: 18px; color: #111111; font-weight: 600;">Related Lead</h3><div class="email-panel" style="background-color: #f0f0f5; padding: 20px 24px; border-radius: 8px; border: 1px solid #e4e4e7;">${params.leadName ? `<div style=\"margin-bottom: 12px;\"><span style=\"display: inline-block; font-weight: 600; color: #3f6212; min-width: 60px;\">Name:</span> <span style=\"color: #111111; font-size: 15px;\">${params.leadName}</span></div>` : ''}${params.leadEmail ? `<div><span style=\"display: inline-block; font-weight: 600; color: #3f6212; min-width: 60px;\">Email:</span> <a href=\"mailto:${params.leadEmail}\" style=\"color: #000000; font-weight: 600; text-decoration: none; font-size: 15px; border-bottom: 1px solid transparent; transition: border-color 0.2s;\">${params.leadEmail}</a></div>` : ''}</div></div>` : ''}
          <div style="text-align: center; margin: 40px 0 32px;">
            <a href="${params.taskUrl}" class="email-cta" style="background: #000000; background-color: #000000; background-image: linear-gradient(#000000, #000000); box-shadow: inset 0 0 0 999px #000000; color: #ffffff; border: 0; display: inline-block; font-weight: 600; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; box-shadow: 0 2px 4px rgba(102, 126, 234, 0.2);">View Task Details</a>
          </div>
          <div style="text-align: center; padding: 24px 0; border-top: 1px solid #e5e7eb;">
            <p style="margin: 0; color: #9ca3af; font-size: 14px;">This email was sent automatically by the Makinari task management system.</p>
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
      <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>New Task Created</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f8fafc; line-height: 1.6;">
      <div class="email-card" style="max-width: 600px; margin: 40px auto; background-color: #fafafa; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); overflow: hidden;">
        <div class="email-header" style="background: #1e1e2d; padding: 32px 40px; text-align: center;">
          <div style="display: inline-block; background-color: rgba(255, 255, 255, 0.1); border-radius: 50%; padding: 12px; margin-bottom: 16px;">
            <div style="width: 24px; height: 24px; background-color: #ffffff; border-radius: 4px; position: relative;">
              <div style="position: absolute; top: 6px; left: 6px; width: 12px; height: 8px; border: 2px solid #000000; border-top: none; border-right: none; transform: rotate(-45deg);"></div>
            </div>
          </div>
          <h1 style="margin: 0; color: #f0f0f5; font-size: 24px; font-weight: 600; letter-spacing: -0.025em;">New Task Created</h1>
          <p style="margin: 8px 0 0; color: #a1a1aa; font-size: 16px; font-weight: 400;">A new task has been added to the system</p>
        </div>
        <div style="padding: 40px;">
          <div style="margin-bottom: 32px; background-color: #f9fafb; border-radius: 12px; padding: 24px; border: 1px solid #e5e7eb;">
            <h2 class="email-heading" style="margin: 0 0 16px; font-size: 20px; color: #111827; font-weight: 600;">${params.taskTitle}</h2>
            ${params.taskDescription ? `<div style=\"margin-bottom: 20px;\"><p style=\"margin: 0; font-size: 15px; color: #6b7280; line-height: 1.6;\">${params.taskDescription}</p></div>` : ''}
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 20px;">
              <div>
                <span class="email-label" style="display: block; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase; margin-bottom: 4px;">Task Type</span>
                <span class="email-text" style="font-size: 14px; color: #111827; font-weight: 500;">${params.taskType}</span>
              </div>
              <div>
                <span class="email-label" style="display: block; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase; margin-bottom: 4px;">Priority</span>
                <span style="display: inline-block; background-color: ${priority.bg}; color: ${priority.color}; padding: 4px 8px; border-radius: 6px; font-size: 12px; font-weight: 600;">${priority.label}</span>
              </div>
            </div>
            ${params.scheduledDate ? `<div style=\"margin-top: 16px;\"><span style=\"display: block; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase; margin-bottom: 4px;\">Scheduled Date</span> <span style=\"font-size: 14px; color: #111827; font-weight: 500;\">${new Date(params.scheduledDate).toLocaleDateString((params as any).locale === 'es' ? 'es-ES' : (params as any).locale === 'fr' ? 'fr-FR' : (params as any).locale === 'de' ? 'de-DE' : (params as any).locale === 'ja' ? 'ja-JP' : 'en-US', {weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit'})}</span></div>` : ''}
          </div>
          ${params.assigneeName || params.assigneeEmail ? `<div style=\"margin-bottom: 32px;\"><h3 style=\"margin: 0 0 16px; font-size: 18px; color: #111111; font-weight: 600;\">Assigned To</h3><div style=\"background-color: #ecfdf5; padding: 20px 24px; border-radius: 8px; border: 1px solid #a7f3d0;\">${params.assigneeName ? `<div style=\\\"margin-bottom: 12px;\\\"><span style=\\\"display: inline-block; font-weight: 600; color: #065f46; min-width: 60px;\\\">Name:</span> <span style=\\\"color: #111111; font-size: 15px;\\\">${params.assigneeName}</span></div>` : ''}${params.assigneeEmail ? `<div><span style=\\\"display: inline-block; font-weight: 600; color: #065f46; min-width: 60px;\\\">Email:</span> <a href=\\\"mailto:${params.assigneeEmail}\\\" style=\\\"color: #000000; font-weight: 600; text-decoration: none; font-size: 15px;\\\">${params.assigneeEmail}</a></div>` : ''}</div></div>` : ''}
          ${params.leadName || params.leadEmail ? `<div style=\"margin-bottom: 32px;\"><h3 style=\"margin: 0 0 16px; font-size: 18px; color: #111111; font-weight: 600;\">Related Lead</h3><div style=\"background-color: #f0f0f5; padding: 20px 24px; border-radius: 8px; border: 1px solid #e4e4e7;\">${params.leadName ? `<div style=\\\"margin-bottom: 12px;\\\"><span style=\\\"display: inline-block; font-weight: 600; color: #3f6212; min-width: 60px;\\\">Name:</span> <span style=\\\"color: #111111; font-size: 15px;\\\">${params.leadName}</span></div>` : ''}${params.leadEmail ? `<div><span style=\\\"display: inline-block; font-weight: 600; color: #3f6212; min-width: 60px;\\\">Email:</span> <a href=\\\"mailto:${params.leadEmail}\\\" style=\\\"color: #000000; font-weight: 600; text-decoration: none; font-size: 15px;\\\">${params.leadEmail}</a></div>` : ''}</div></div>` : ''}
          <div style="text-align: center; margin: 40px 0 32px;">
            <a href="${params.taskUrl}" class="email-cta" style="background: #000000; background-color: #000000; background-image: linear-gradient(#000000, #000000); box-shadow: inset 0 0 0 999px #000000; color: #ffffff; border: 0; display: inline-block; font-weight: 600; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; box-shadow: 0 2px 4px rgba(99, 102, 241, 0.2);">View Task Details</a>
          </div>
          <div style="text-align: center; padding: 24px 0; border-top: 1px solid #e5e7eb;">
            <p style="margin: 0; color: #9ca3af; font-size: 14px;">This email was sent automatically by the Makinari task management system.</p>
          </div>
        </div>
      </div>
    </body>
    </html>
  `;
}


