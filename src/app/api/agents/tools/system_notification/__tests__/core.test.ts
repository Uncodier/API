import { randomBytes, randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { sendGridService } from '@/lib/services/sendgrid-service';
import { AgentMailSendService } from '@/lib/services/email/AgentMailSendService';
import { WhatsAppSendService } from '@/lib/services/whatsapp/WhatsAppSendService';
import { NotificationService } from '@/lib/services/notification-service';
import { getRedisClient } from '@/lib/utils/redis-client';
import { notifySystemNotificationCore } from '../core';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('@/lib/services/sendgrid-service', () => ({ sendGridService: { sendEmail: jest.fn() } }));
jest.mock('@/lib/services/email/AgentMailSendService', () => ({ AgentMailSendService: { sendViaAgentMail: jest.fn() } }));
jest.mock('@/lib/services/whatsapp/WhatsAppSendService', () => ({ WhatsAppSendService: { sendMessage: jest.fn() } }));
jest.mock('@/lib/services/notification-service', () => ({
  NotificationService: { createNotification: jest.fn() }, NotificationCategory: {}, NotificationPriority: {}, NotificationType: {},
}));
jest.mock('@/lib/services/email/EmailSendService', () => ({ EmailSendService: { escapeHtml: (x: string) => x, renderMessageWithLists: (x: string) => x } }));
jest.mock('@/lib/services/team-notification-service', () => ({ TeamNotificationService: {} }));
jest.mock('@/lib/utils/redis-client', () => ({ getRedisClient: jest.fn() }));
jest.mock('@/lib/emails/brand', () => ({ EMAIL_BRAND: {}, emailBrandHeadTags: () => '', emailCtaButton: () => '' }));

const originalEnv = process.env;
const params = { site_id: 'site-1', team_member_email: 'member@example.invalid', title: 'Notice', message: 'Body', channels: ['email'] };

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { NODE_ENV: 'test', TRANSACTIONAL_EMAIL_PROVIDER: 'zavu' };
  const query: any = { select: jest.fn(), eq: jest.fn(), single: jest.fn().mockResolvedValue({ data: null }) };
  query.select.mockReturnValue(query); query.eq.mockReturnValue(query);
  (supabaseAdmin.from as jest.Mock).mockReturnValue(query);
  (getRedisClient as jest.Mock).mockReturnValue({ get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue('OK') });
  (sendGridService.sendEmail as jest.Mock).mockResolvedValue({ success: true });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { process.env = originalEnv; jest.restoreAllMocks(); });

it.each(['zavu', 'sendgrid'])('uses the configured facade exactly once for %s, never AgentMail', async provider => {
  process.env.TRANSACTIONAL_EMAIL_PROVIDER = provider;
  const result = await notifySystemNotificationCore(params);
  expect(result.email_sent).toBe(true);
  expect(sendGridService.sendEmail).toHaveBeenCalledTimes(1);
  expect(sendGridService.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: params.team_member_email, subject: params.title,
    categories: ['system-notification'], customArgs: { site_id: params.site_id } }));
  expect(AgentMailSendService.sendViaAgentMail).not.toHaveBeenCalled();
});

it.each(['failure', 'timeout'])('never falls back or retries on %s', async failure => {
  const sensitive = randomBytes(32).toString('hex');
  if (failure === 'timeout') (sendGridService.sendEmail as jest.Mock).mockRejectedValue(new Error(sensitive));
  else (sendGridService.sendEmail as jest.Mock).mockResolvedValue({ success: false });
  expect((await notifySystemNotificationCore(params)).email_sent).toBe(false);
  expect(sendGridService.sendEmail).toHaveBeenCalledTimes(1);
  expect(AgentMailSendService.sendViaAgentMail).not.toHaveBeenCalled();
  expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain(sensitive);
});

it('does not send email when explicit channels omit it', async () => {
  await notifySystemNotificationCore({ ...params, channels: ['in_app'] });
  expect(sendGridService.sendEmail).not.toHaveBeenCalled();
  expect(AgentMailSendService.sendViaAgentMail).not.toHaveBeenCalled();
});

it.each([true, false])('links in-app and external channels to real routes (instance: %s)', async hasInstance => {
  const siteId = randomUUID();
  const instanceId = hasInstance ? randomUUID() : undefined;
  const userId = randomUUID();
  const query: any = { select: jest.fn(), eq: jest.fn(), single: jest.fn().mockResolvedValue({ data: { id: userId } }) };
  query.select.mockReturnValue(query); query.eq.mockReturnValue(query);
  (supabaseAdmin.from as jest.Mock).mockReturnValue(query);
  (NotificationService.createNotification as jest.Mock).mockResolvedValue({ id: randomUUID() });
  const result = await notifySystemNotificationCore({ ...params, site_id: siteId, instance_id: instanceId,
    channels: ['in_app', 'email'], phone_number: '+15555550100' });
  expect(NotificationService.createNotification).toHaveBeenCalledWith(expect.objectContaining({
    user_id: userId, message: params.message,
    related_entity_type: hasInstance ? 'instance' : 'site',
    related_entity_id: instanceId || siteId,
  }));
  expect(result.instance_url).toBe(hasInstance
    ? `https://app.uncodie.com/robots?instance=${instanceId}` : 'https://app.uncodie.com/projects');
  expect(result.notification_sent).toBe(true);
});

it('preserves WhatsApp channel handling and its success response', async () => {
  (WhatsAppSendService.sendMessage as jest.Mock).mockResolvedValue({ success: true });
  const result = await notifySystemNotificationCore({ ...params, channels: ['whatsapp'], phone_number: '+15555550100' });
  expect(result.whatsapp_sent).toBe(true); expect(result.email_sent).toBe(false);
  expect(sendGridService.sendEmail).not.toHaveBeenCalled();
  expect(NotificationService.createNotification).not.toHaveBeenCalled();
});
