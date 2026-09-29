import { NextRequest } from 'next/server';
import { databaseFixture } from './daily-standup-db-mock';
import { POST } from '@/app/api/notifications/dailyStandUp/route';
import { isDailyStandupNotificationAllowed } from '../dailyStandupNotificationPolicy';
import { REPORT_SECTIONS } from '../dailyStandupReportSections';

const SITE = '11111111-1111-4111-8111-111111111111';
let mockDb: ReturnType<typeof databaseFixture>;
const mockNotify = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: (...args: [string]) => mockDb.from(...args) } }));
jest.mock('@/lib/services/team-notification-service', () => ({ TeamNotificationService: { notifyTeam: (...args: unknown[]) => mockNotify(...args) } }));
jest.mock('@/lib/services/notification-service', () => ({ NotificationType: { INFO: 'info' }, NotificationCategory: { ANALYSIS_INSIGHTS: 'analysis' } }));
jest.mock('@/lib/services/email/EmailSendService', () => ({ EmailSendService: {
  escapeHtml: (value: string) => value,
  escapeAttr: (value: string) => value,
  renderMessageWithLists: (value: string) => `<p>${value}</p>`,
} }));

function config(overrides: Record<string, unknown> = {}, timezone: unknown = 'UTC') {
  return { activities: { daily_resume_and_stand_up: { status: 'active', weekdays: [2], report_sections: ['tasks'], ...overrides } },
    business_hours: { timezone } };
}
function request(overrides: Record<string, unknown> = {}) {
  return new NextRequest('http://localhost/notifications', { method: 'POST', body: JSON.stringify({
    site_id: SITE, subject: 'Daily Standup', message: 'Tasks\nOne task.', report_sections: ['tasks'], ...overrides,
  }) });
}
beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers().setSystemTime(new Date('2026-09-29T12:00:00Z'));
  mockDb = databaseFixture();
  mockDb.rows.settings = [config()];
  mockDb.rows.sites = [{ name: 'Test site', url: 'https://example.invalid' }];
  mockNotify.mockResolvedValue({ success: true, notificationsSent: 1, emailsSent: 1 });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

test('scoped email and notification never append legacy health/systemAnalysis', async () => {
  const response = await POST(request({
    health: { status: 'RED', reason: 'DISABLED_SALES_HEALTH', priorities: ['DISABLED_SOCIAL'] },
    systemAnalysis: { success: true, command_id: 'old', analysis_type: 'legacy',
      strategic_analysis: { business_assessment: 'DISABLED_INVENTORY' } },
  }));
  expect(response.status).toBe(200);
  expect((await response.json()).data.business_assessment_included).toBe(false);
  const args = mockNotify.mock.calls[0][0];
  const email = args.buildEmail('en');
  expect(email.html).toContain('One task.');
  expect(email.html).not.toMatch(/DISABLED_|Business Health/);
  expect(args.message).not.toMatch(/DISABLED_/);
});
test.each([[], null, ['unknown'], ['tasks', 'unknown'], 'tasks'])('invalid request selection %p never sends', async sections => {
  expect((await POST(request({ report_sections: sections }))).status).toBe(400);
  expect(mockNotify).not.toHaveBeenCalled();
  expect(mockDb.from).not.toHaveBeenCalled();
});
test.each([
  { report_sections: [] }, { report_sections: null }, { report_sections: ['sales'] },
  { report_sections: ['sales', 'tasks'] }, { status: 'inactive' }, { weekdays: [1, 5] }, { weekdays: null },
])('latest persisted %p prevents stale/retried delivery', async overrides => {
  mockDb.rows.settings = [config(overrides)];
  expect((await POST(request())).status).toBe(409);
  expect(mockNotify).not.toHaveBeenCalled();
});
test('DB failure fails closed without sending', async () => {
  mockDb.errors.settings = { message: 'offline' };
  expect((await POST(request())).status).toBe(500);
  expect(mockNotify).not.toHaveBeenCalled();
});
test('missing settings never enables scoped delivery', async () => {
  mockDb.rows.settings = [];
  expect((await POST(request())).status).toBe(409);
  expect(mockNotify).not.toHaveBeenCalled();
});
test('unscoped legacy report cannot bypass a restricted section selection', async () => {
  expect(await isDailyStandupNotificationAllowed(SITE, undefined)).toBe(false);
});
test('legacy missing sections default all only when active and locally eligible', async () => {
  mockDb.rows.settings = [config({ report_sections: undefined })];
  expect(await isDailyStandupNotificationAllowed(SITE, undefined)).toBe(true);
  mockDb.rows.settings = [config({ report_sections: undefined, status: 'inactive' })];
  expect(await isDailyStandupNotificationAllowed(SITE, undefined)).toBe(false);
  mockDb.rows.settings = [config({ report_sections: undefined, weekdays: [1, 5] })];
  expect(await isDailyStandupNotificationAllowed(SITE, undefined)).toBe(false);
});
test('timezone-local day wins over UTC; invalid timezone is fail closed', async () => {
  mockDb.rows.settings = [config({ weekdays: [1], report_sections: REPORT_SECTIONS }, 'America/Mexico_City')];
  expect(await isDailyStandupNotificationAllowed(SITE, REPORT_SECTIONS, new Date('2026-09-29T02:00:00Z'))).toBe(true);
  mockDb.rows.settings = [config({}, 'not/a-timezone')];
  expect(await isDailyStandupNotificationAllowed(SITE, ['tasks'])).toBe(false);
});