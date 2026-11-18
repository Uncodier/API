import { randomUUID } from 'node:crypto';
import { TaskNotifier } from '../TaskNotifier';
import { TeamNotificationService } from '../team-notification-service';

jest.mock('@/lib/database/supabase-server', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('@/lib/services/team-notification-service', () => ({ TeamNotificationService: { notifyTeam: jest.fn() } }));
jest.mock('@/lib/services/notification-service', () => ({ NotificationType: { INFO: 'info' }, NotificationCategory: { TASKS_REMINDERS: 'tasks_reminders' } }));
jest.mock('@/lib/services/templates/task-email-templates', () => ({ generateTaskTeamEmailHtml: jest.fn(() => '<p>Task details</p>') }));

it('sends task description, priority and schedule with the related task CTA', async () => {
  const task = {
    id: randomUUID(), site_id: randomUUID(), title: 'Review proposal',
    description: 'Compare pricing\nRequest approval before sending.', type: 'follow_up',
    priority: 0, scheduled_date: '2026-11-20T12:00:00Z',
  };
  await TaskNotifier.notifyTaskCreated({ task });
  expect(TeamNotificationService.notifyTeam).toHaveBeenCalledWith(expect.objectContaining({
    relatedEntityType: 'task', relatedEntityId: task.id,
    message: expect.stringContaining(task.description),
  }));
  const message = (TeamNotificationService.notifyTeam as jest.Mock).mock.calls[0][0].message;
  expect(message).toContain('Priority: 0');
  expect(message).toContain(`Scheduled for: ${task.scheduled_date}`);
  expect(message).toContain(`Task: ${task.title}`);
  expect(message).not.toContain('undefined');
});