import { NotificationType } from '@/lib/services/notification-service';
import { TeamNotificationService } from '@/lib/services/team-notification-service';
import { supabaseAdmin } from '@/lib/database/supabase-server';
import { generateTaskTeamEmailHtml } from '@/lib/services/templates/task-email-templates';

export class TaskNotifier {
  static async notifyTaskCreated(params: {
    task: {
      id: string;
      title: string;
      description?: string | null;
      type: string;
      priority: number;
      site_id: string;
      lead_id?: string | null;
      assignee?: string | null;
      scheduled_date?: string | null;
    };
  }) {
    const { task } = params;

    // Normalize base app URL
    const rawBase = (process.env.NEXT_PUBLIC_APP_URL || 'https://app.uncodie.com').trim();
    let baseUrl = rawBase
      // Fix missing colon after http/https if present
      .replace(/^http\/\/(?!:)/, 'http://')
      .replace(/^https\/\/(?!:)/, 'https://');
    if (!/^https?:\/\//i.test(baseUrl)) {
      baseUrl = `https://${baseUrl}`;
    }
    baseUrl = baseUrl.replace(/\/$/, '');

    // Fetch optional lead info
    let leadInfo: { name?: string | null; email?: string | null } | null = null;
    if (task.lead_id) {
      try {
        const { data } = await supabaseAdmin
          .from('leads')
          .select('name, email')
          .eq('id', task.lead_id)
          .single();
        leadInfo = data as any;
      } catch {}
    }

    // Fetch optional assignee info
    let assigneeInfo: { name?: string | null; email?: string | null } | null = null;
    if (task.assignee) {
      try {
        const { data: assignee } = await supabaseAdmin.auth.admin.getUserById(task.assignee);
        if (assignee?.user) {
          assigneeInfo = {
            name: assignee.user.user_metadata?.name || assignee.user.email,
            email: assignee.user.email,
          };
        }
      } catch {}
    }

    // Build task URL to Control Center
    const taskUrl = `${baseUrl}/control-center/${task.id}`;

    // Use shared rich HTML template
    const html = generateTaskTeamEmailHtml({
      recipientName: 'Team',
      taskTitle: task.title,
      taskDescription: task.description || undefined,
      taskType: task.type,
      priority: task.priority,
      leadName: leadInfo?.name || undefined,
      leadEmail: leadInfo?.email || undefined,
      assigneeName: assigneeInfo?.name || undefined,
      assigneeEmail: assigneeInfo?.email || undefined,
      scheduledDate: task.scheduled_date || undefined,
      taskUrl,
      agentName: 'System'
    });

    return TeamNotificationService.notifyTeam({
      siteId: task.site_id,
      title: `New task created: ${task.title}`,
      message: `A new ${task.type} task has been created${leadInfo?.name ? ` for lead ${leadInfo.name}` : ''}.`,
      htmlContent: html,
      type: NotificationType.INFO,
      categories: ['task-notification', 'task-created'],
      customArgs: {
        taskId: task.id,
        taskType: task.type,
      },
      relatedEntityType: 'task',
      relatedEntityId: task.id,
    });
  }
}

export default TaskNotifier;


