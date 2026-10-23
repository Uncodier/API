import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import nodemailer from 'nodemailer';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { NotificationService, NotificationType, NotificationPriority } from '@/lib/services/notification-service';
import { BaseNotification, type NotificationData } from '@/lib/services/notifications/notification-service';
import { TeamNotificationService, type TeamMember } from '@/lib/services/team-notification-service';
import { sendGridService } from '@/lib/services/sendgrid-service';
import { getLatestTelemetry, recordTelemetry, type TelemetryRecord } from '@/lib/status/telemetry';
import { notificationsHandler } from '@/lib/status/handlers/notifications';

// All I/O boundaries are inert. No developer env files, DB client, SMTP or
// SendGrid/Zavu SDK implementation is loaded by these offline tests.
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('@/lib/status/telemetry', () => ({ getLatestTelemetry: jest.fn(), recordTelemetry: jest.fn() }));
jest.mock('nodemailer', () => ({ __esModule: true, default: { createTransport: jest.fn() } }));
jest.mock('uuid', () => ({ v4: () => require('node:crypto').randomUUID() }));
jest.mock('@/lib/services/sendgrid-service', () => ({ sendGridService: {
  sendEmail: jest.fn(), getConfig: jest.fn(), healthCheck: jest.fn(),
} }));
jest.mock('@/lib/services/email/EmailSendService', () => ({ EmailSendService: {} }));
jest.mock('@/lib/i18n/email-locale', () => ({
  DEFAULT_EMAIL_LOCALE: 'en', resolveEmailLocale: async () => 'en',
  tryNormalizeEmailLocale: (language: string) => language || null,
}));

const originalEnv = process.env;
const now = Date.parse('2026-10-20T12:00:00.000Z');
const latest = jest.mocked(getLatestTelemetry);
const record = jest.mocked(recordTelemetry);
const send = jest.mocked(sendGridService.sendEmail);
const from = jest.mocked(supabaseAdmin.from);
const credential = () => randomBytes(32).toString('hex');
const smtpSend = jest.fn<(...args: unknown[]) => Promise<any>>();

function receipt(status: TelemetryRecord['status'] = 'up', ageMs = 0): TelemetryRecord {
  return { status, message: credential(), latency_ms: 0, created_at: new Date(now - ageMs).toISOString() };
}

function insertResult(data: unknown, error: unknown = null) {
  const single = jest.fn<() => Promise<any>>().mockResolvedValue({ data, error });
  const select = jest.fn(() => ({ single }));
  const insert = jest.fn((_values: Record<string, unknown>[]) => ({ select }));
  from.mockReturnValue({ insert } as any);
  return { insert, select, single };
}

function privateData() {
  const email = `${credential()}@example.invalid`;
  const subject = credential();
  const html = `<p>${credential()}</p>`;
  const user = credential();
  const password = credential();
  const token = credential();
  const url = new URL('https://provider.example.invalid/error');
  url.username = user;
  url.password = password;
  url.searchParams.set('token', token);
  return { email, subject, html, user, password, token, url,
    values: [email, subject, html, user, password, token] };
}

function expectPrivate(values: string[]) {
  const telemetry = JSON.stringify(record.mock.calls);
  for (const value of values) expect(telemetry).not.toContain(value);
}

function inAppParams() {
  return { user_id: randomUUID(), site_id: randomUUID(), title: credential(), message: credential(),
    type: NotificationType.INFO, priority: NotificationPriority.NORMAL };
}

function smtpConfig() {
  process.env.EMAIL_HOST = 'smtp.example.invalid';
  process.env.EMAIL_USER = credential();
  process.env.EMAIL_PASSWORD = credential();
}

class TestNotification extends BaseNotification {
  generateEmailSubject() { return this.data.subject; }
  generateEmailHtml() { return this.data.data.html; }
}

function baseNotification(recipients: string[], subject = credential(), html = credential()) {
  const data: NotificationData = { id: randomUUID(), type: 'lead-attention', recipients, subject,
    data: { html }, priority: 'normal', channel: 'email', site_id: randomUUID(), created_at: new Date(now) };
  return new TestNotification(data);
}

function teamMember(language = 'en', emailEnabled = true, pushEnabled = true): TeamMember {
  return { user_id: randomUUID(), email: `${credential()}@example.invalid`, role: 'owner',
    language, emailEnabled, pushEnabled };
}

function teamParams() {
  return { siteId: randomUUID(), title: credential(), message: credential(), htmlContent: `<p>${credential()}</p>` };
}

beforeEach(() => {
  jest.resetAllMocks();
  process.env = { NODE_ENV: 'test' };
  jest.spyOn(Date, 'now').mockReturnValue(now);
  jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden in offline tests'));
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  record.mockResolvedValue(undefined);
  latest.mockResolvedValue(null);
  send.mockResolvedValue({ success: true });
  jest.mocked(sendGridService.getConfig).mockReturnValue({ sandboxMode: false });
  jest.mocked(nodemailer.createTransport).mockReturnValue({ sendMail: smtpSend } as any);
  // Reset the existing cached transporter without exposing credentials.
  (NotificationService as any).transporter = null;
});

afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(sendGridService.healthCheck).not.toHaveBeenCalled();
  process.env = originalEnv;
  jest.restoreAllMocks();
});

describe('actual in-app insert evidence', () => {
  it('records only persistence after the real insert result; preserves returned object', async () => {
    const params = inAppParams();
    const saved = { ...params, id: randomUUID() };
    const db = insertResult(saved);
    expect(await NotificationService.createNotification(params)).toBe(saved);
    expect(from).toHaveBeenCalledWith('notifications');
    expect(db.insert).toHaveBeenCalledWith([expect.objectContaining({ user_id: params.user_id,
      site_id: params.site_id, title: params.title, message: params.message, type: params.type })]);
    expect(record).toHaveBeenCalledWith('notifications_in_app', 'up', 'In-app notification persisted', 0);
    expect(send).not.toHaveBeenCalled();
    expect(record.mock.calls.map(([key]) => key)).toEqual(['notifications_in_app']);
    expectPrivate([params.user_id, params.site_id, params.title, params.message]);
  });

  it.each(['error', 'throw', 'empty'])('reports %s persistence failure without copying DB errors', async failure => {
    const sensitive = privateData();
    const db = insertResult(null, failure === 'error' ? { message: sensitive.url.toString() } : null);
    if (failure === 'throw') db.single.mockRejectedValue(new Error(sensitive.url.toString()));
    expect(await NotificationService.createNotification(inAppParams())).toBeNull();
    expect(record).toHaveBeenCalledWith('notifications_in_app', 'down', expect.any(String), 0);
    expectPrivate(sensitive.values);
  });

  it('does not record execution when invalid input fails before a DB attempt', async () => {
    expect(await NotificationService.createNotification(null as any)).toBeNull();
    expect(from).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('awaits best-effort telemetry and preserves persistence if telemetry rejects', async () => {
    const saved = { id: randomUUID() };
    insertResult(saved);
    let reject!: (error: Error) => void;
    record.mockImplementation(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    let settled = false;
    const pending = NotificationService.createNotification(inAppParams()).then(result => { settled = true; return result; });
    await Promise.resolve(); await Promise.resolve();
    expect(record).toHaveBeenCalled();
    expect(settled).toBe(false);
    reject(new Error(credential()));
    expect(await pending).toBe(saved);
  });
});

describe('SMTP recipient acceptance, not mailbox delivery', () => {
  it.each([
    ['up', 2, 0], ['degraded', 1, 1], ['degraded', 1, 0], ['down', 0, 2],
  ] as Array<['up' | 'degraded' | 'down', number, number]>)('records %s from the accepted/rejected envelope and preserves true return', async (status, accepted, rejected) => {
    smtpConfig();
    const a = privateData(); const b = privateData();
    smtpSend.mockResolvedValue({ accepted: [a.email, b.email].slice(0, accepted),
      rejected: [a.email, b.email].slice(0, rejected), messageId: randomUUID() });
    expect(await NotificationService.sendEmail({ to: [a.email, b.email], subject: a.subject, html: a.html })).toBe(true);
    expect(record).toHaveBeenCalledWith('notifications_email', status, expect.any(String), 0);
    if (status !== 'down') expect(record.mock.calls[0][2]).toContain('mailbox delivery unconfirmed');
    expectPrivate([...a.values, ...b.values, process.env.EMAIL_USER!, process.env.EMAIL_PASSWORD!]);
  });

  it('preserves failed send return and emits a bounded failure receipt', async () => {
    smtpConfig(); const sensitive = privateData();
    smtpSend.mockRejectedValue(new Error(sensitive.url.toString()));
    expect(await NotificationService.sendEmail({ to: sensitive.email, subject: sensitive.subject, html: sensitive.html })).toBe(false);
    expect(record).toHaveBeenCalledWith('notifications_email', 'down', expect.any(String), 0);
    expectPrivate(sensitive.values);
  });

  it.each([{ to: [] as string[] }, { to: [''] }])('never attests zero recipients even if sendMail resolves', async ({ to }) => {
    smtpConfig(); smtpSend.mockResolvedValue({ accepted: [], rejected: [] });
    expect(await NotificationService.sendEmail({ to, subject: credential(), html: credential() })).toBe(true);
    expect(record).not.toHaveBeenCalled();
  });

  it('does not equate an unknown SMTP result with acceptance and tolerates telemetry rejection', async () => {
    smtpConfig(); smtpSend.mockResolvedValue({ messageId: randomUUID() });
    const params = { to: `${credential()}@example.invalid`, subject: credential(), html: credential() };
    expect(await NotificationService.sendEmail(params)).toBe(true);
    expect(record).not.toHaveBeenCalled();
    smtpSend.mockResolvedValue({ accepted: [params.to], rejected: [] });
    record.mockRejectedValue(new Error(credential()));
    expect(await NotificationService.sendEmail(params)).toBe(true);
  });
});

describe('BaseNotification provider acceptance', () => {
  it.each([['up', true, true], ['degraded', true, false], ['down', false, false]] as Array<['up' | 'degraded' | 'down', boolean, boolean]>)(
    'aggregates %s without changing legacy any-success return', async (status, first, second) => {
      const a = privateData(); const b = privateData();
      send.mockResolvedValueOnce({ success: first, error: a.url.toString() })
        .mockResolvedValueOnce({ success: second, error: b.url.toString() });
      const result = await baseNotification([a.email, b.email], a.subject, a.html).send();
      expect(result.success).toBe(first || second);
      expect(record).toHaveBeenCalledWith('notifications_email', status, expect.any(String), 0);
      expectPrivate([...a.values, ...b.values]);
    });

  it('waits for sibling sends after a provider rejection and observes partial acceptance', async () => {
    const recipients = [privateData().email, privateData().email];
    let resolve!: (value: { success: boolean }) => void;
    send.mockRejectedValueOnce(new Error(credential())).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = baseNotification(recipients).send();
    await Promise.resolve(); await Promise.resolve();
    expect(record).not.toHaveBeenCalled();
    resolve({ success: true });
    expect((await pending).success).toBe(false);
    expect(record).toHaveBeenCalledWith('notifications_email', 'degraded', expect.any(String), 0);
  });

  it('uses matching per-recipient acceptance rather than aggregate status', async () => {
    const a = privateData(); const b = privateData();
    send.mockResolvedValueOnce({ success: false, provider: 'zavu', recipientResults: [{ to: a.email, success: true }] })
      .mockResolvedValueOnce({ success: true, recipientResults: [{ to: privateData().email, success: true }] });
    // Legacy success uses the aggregate result; telemetry uses matching recipients.
    expect((await baseNotification([a.email, b.email]).send()).success).toBe(true);
    expect(record).toHaveBeenCalledWith('notifications_email', 'degraded', expect.any(String), 0);
    expectPrivate([...a.values, ...b.values]);
  });

  it('reports all failed sends even when invalid provider config cannot be read', async () => {
    send.mockResolvedValue({ success: false });
    jest.mocked(sendGridService.getConfig).mockImplementation(() => { throw new Error(credential()); });
    expect((await baseNotification([privateData().email]).send()).success).toBe(false);
    expect(record).toHaveBeenCalledWith('notifications_email', 'down', expect.any(String), 0);
  });

  it('never records a success for no recipients or sandbox validation', async () => {
    expect((await baseNotification([]).send()).success).toBe(false);
    expect(send).not.toHaveBeenCalled(); expect(record).not.toHaveBeenCalled();
    jest.mocked(sendGridService.getConfig).mockReturnValue({ sandboxMode: true });
    expect((await baseNotification([privateData().email]).send()).success).toBe(true);
    expect(record).not.toHaveBeenCalled();
  });

  it('awaits telemetry and keeps successful caller result when telemetry rejects', async () => {
    let reject!: (error: Error) => void;
    record.mockImplementation(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    let settled = false;
    const pending = baseNotification([privateData().email]).send().then(result => { settled = true; return result; });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(record).toHaveBeenCalled(); expect(settled).toBe(false);
    reject(new Error(credential()));
    expect((await pending).success).toBe(true);
  });
});

describe('central team notification receipts preserve preferences and returns', () => {
  it('keeps channel preferences and observes separate persistence/acceptance', async () => {
    const emailOnly = teamMember('en', true, false);
    const pushOnly = teamMember('en', false, true);
    const params = teamParams();
    jest.spyOn(TeamNotificationService, 'getEligibleTeamMembers').mockResolvedValue([emailOnly, pushOnly]);
    const create = jest.spyOn(NotificationService, 'createNotification').mockResolvedValue({ id: randomUUID() });
    expect(await TeamNotificationService.notifyTeam(params)).toMatchObject({ success: true, notificationsSent: 1,
      emailsSent: 1, totalMembers: 2, membersWithEmailEnabled: 1 });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ user_id: pushOnly.user_id }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: [emailOnly.email], subject: params.title,
      html: params.htmlContent }));
    expect(record.mock.calls.map(([key, status]) => [key, status])).toEqual([
      ['notifications_in_app', 'up'], ['notifications_email', 'up'],
    ]);
    expectPrivate([params.siteId, params.title, params.message, params.htmlContent, emailOnly.email, pushOnly.email]);
  });

  it.each([['degraded', true], ['down', false]] as Array<['degraded' | 'down', boolean]>)('observes Zavu %s while preserving aggregate-failure emailsSent', async (status, accepted) => {
    const members = [teamMember('en', true, false), teamMember('en', true, false)];
    jest.spyOn(TeamNotificationService, 'getEligibleTeamMembers').mockResolvedValue(members);
    const secret = privateData();
    send.mockResolvedValue({ success: false, provider: 'zavu', error: secret.url.toString(), recipientResults: [
      { to: members[0].email, success: accepted }, { to: members[1].email, success: false },
    ] });
    expect(await TeamNotificationService.notifyTeam(teamParams())).toMatchObject({ success: false, emailsSent: 0, notificationsSent: 0 });
    expect(record.mock.calls.map(([key, value]) => [key, value])).toEqual([['notifications_email', status]]);
    expectPrivate([...secret.values, ...members.map(member => member.email)]);
  });

  it('aggregates locale-group success and failure, preserving render and counters', async () => {
    const members = [teamMember('en'), teamMember('es')];
    jest.spyOn(TeamNotificationService, 'getEligibleTeamMembers').mockResolvedValue(members);
    jest.spyOn(NotificationService, 'createNotification').mockResolvedValueOnce({ id: randomUUID() }).mockResolvedValueOnce(null);
    send.mockResolvedValueOnce({ success: true }).mockResolvedValueOnce({ success: false });
    const buildEmail = jest.fn((locale: string) => ({ subject: locale, html: `<p>${locale}</p>` }));
    expect(await TeamNotificationService.notifyTeam({ ...teamParams(), buildEmail })).toMatchObject({
      success: true, notificationsSent: 1, emailsSent: 1,
    });
    expect(buildEmail.mock.calls.map(([locale]) => locale)).toEqual(['en', 'es']);
    expect(record.mock.calls.map(([key, status]) => [key, status])).toEqual([
      ['notifications_in_app', 'degraded'], ['notifications_email', 'degraded'],
    ]);
  });

  it('keeps the legacy no-members success but emits no functional receipts', async () => {
    jest.spyOn(TeamNotificationService, 'getEligibleTeamMembers').mockResolvedValue([]);
    expect(await TeamNotificationService.notifyTeam(teamParams())).toMatchObject({ success: true, emailsSent: 0, notificationsSent: 0 });
    expect(send).not.toHaveBeenCalled(); expect(from).not.toHaveBeenCalled(); expect(record).not.toHaveBeenCalled();
  });

  it('does not turn recipient lookup failure into persistence or send evidence', async () => {
    jest.spyOn(TeamNotificationService, 'getEligibleTeamMembers').mockRejectedValue(new Error(credential()));
    expect((await TeamNotificationService.notifyTeam(teamParams())).success).toBe(false);
    expect(record).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });

  it('reports all failed emails even when provider config is invalid', async () => {
    jest.spyOn(TeamNotificationService, 'getEligibleTeamMembers').mockResolvedValue([teamMember('en', true, false)]);
    send.mockResolvedValue({ success: false });
    jest.mocked(sendGridService.getConfig).mockImplementation(() => { throw new Error(credential()); });
    expect((await TeamNotificationService.notifyTeam(teamParams())).success).toBe(false);
    expect(record).toHaveBeenCalledWith('notifications_email', 'down', expect.any(String), 0);
  });

  it('preserves counters and awaits both channel receipts when telemetry rejects', async () => {
    jest.spyOn(TeamNotificationService, 'getEligibleTeamMembers').mockResolvedValue([teamMember()]);
    jest.spyOn(NotificationService, 'createNotification').mockResolvedValue({ id: randomUUID() });
    record.mockRejectedValue(new Error(credential()));
    expect(await TeamNotificationService.notifyTeam(teamParams())).toMatchObject({ success: true, emailsSent: 1, notificationsSent: 1 });
    expect(record).toHaveBeenCalledTimes(2);
  });
});

describe('independent notification health, read-only and 15 minute freshness', () => {
  it('does not infer health from configured providers, table reads or legacy generic receipts', async () => {
    process.env.SENDGRID_API_KEY = credential();
    latest.mockImplementation(async key => key === 'notifications' ? receipt() : null);
    const result = await notificationsHandler.runCheck();
    expect(result).toMatchObject({ status: 'skipped', checks: { verification: 'unverified', observedCount: 0, expectedCount: 2 } });
    expect(latest.mock.calls).toEqual([['notifications_in_app', 0.25], ['notifications_email', 0.25]]);
    expect(from).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    expect(nodemailer.createTransport).not.toHaveBeenCalled(); expect(record).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(process.env.SENDGRID_API_KEY);
  });

  it.each(['notifications_in_app', 'notifications_email'])('a lone %s success cannot attest both expected channels', async key => {
    process.env.SENDGRID_API_KEY = credential();
    latest.mockImplementation(async value => value === key ? receipt() : null);
    expect(await notificationsHandler.runCheck()).toMatchObject({ status: 'degraded', checks: {
      verification: 'partial', observedCount: 1, observedFailure: false,
    } });
  });

  it('can observe only in-app when no email transport is configured, and still labels email unverified', async () => {
    latest.mockImplementation(async key => key === 'notifications_in_app' ? receipt() : null);
    expect(await notificationsHandler.runCheck()).toMatchObject({ status: 'up', checks: { expectedCount: 1,
      in_app: { status: 'up' }, email: { expected: false, status: 'skipped', verification: 'unverified' } } });
  });

  it.each(['sendgrid', 'zavu', 'smtp'] as const)('requires both configured %s channels before up', async provider => {
    if (provider === 'smtp') smtpConfig();
    else {
      process.env.TRANSACTIONAL_EMAIL_PROVIDER = provider;
      if (provider === 'sendgrid') process.env.SENDGRID_API_KEY = credential();
      else {
        process.env.ZAVUDEV_API_KEY = credential(); process.env.TRANSACTIONAL_EMAIL_FROM_EMAIL = privateData().email;
        process.env.TRANSACTIONAL_EMAIL_ZAVU_SITE_ID = randomUUID(); process.env.TRANSACTIONAL_EMAIL_ZAVU_CONNECTION_ID = randomUUID();
      }
    }
    latest.mockResolvedValue(receipt());
    expect(await notificationsHandler.runCheck()).toMatchObject({ status: 'up', latencyMs: 0, checks: {
      observedCount: 2, expectedCount: 2, verification: 'observed',
      email: { scope: 'Provider recipient acceptance; not confirmed mailbox delivery' },
    } });
  });

  it.each(['invalid', 'incomplete-zavu', 'incomplete-smtp'])('keeps %s configuration expected rather than hiding it behind in-app success', async config => {
    if (config === 'invalid') process.env.TRANSACTIONAL_EMAIL_PROVIDER = credential();
    else if (config === 'incomplete-zavu') process.env.TRANSACTIONAL_EMAIL_PROVIDER = 'zavu';
    else process.env.EMAIL_HOST = 'smtp.example.invalid';
    latest.mockImplementation(async key => key === 'notifications_in_app' ? receipt() : null);
    const result = await notificationsHandler.runCheck();
    expect(result).toMatchObject({ status: 'degraded', checks: { expectedCount: 2, verification: 'partial', email: { configured: false } } });
    if (config === 'invalid') expect(JSON.stringify(result)).not.toContain(process.env.TRANSACTIONAL_EMAIL_PROVIDER);
  });

  it.each(['notifications_in_app', 'notifications_email'])('preserves fresh %s failures even with another success or missing evidence', async key => {
    process.env.SENDGRID_API_KEY = credential();
    for (const other of [receipt(), null]) {
      latest.mockImplementation(async value => value === key ? receipt('down') : other);
      expect(await notificationsHandler.runCheck()).toMatchObject({ status: 'down', checks: { observedFailure: true } });
    }
  });

  it('partial provider acceptance stays degraded with complete coverage', async () => {
    process.env.SENDGRID_API_KEY = credential();
    latest.mockImplementation(async key => receipt(key === 'notifications_email' ? 'degraded' : 'up'));
    expect(await notificationsHandler.runCheck()).toMatchObject({ status: 'degraded', checks: { verification: 'observed', observedFailure: true } });
  });

  it.each([15 * 60 * 1000 + 1, 20 * 60 * 1000, -1, NaN])('rejects stale/future/invalid timestamp age %s independently', async age => {
    process.env.SENDGRID_API_KEY = credential();
    const stale = receipt('down');
    stale.created_at = Number.isNaN(age) ? 'invalid' : new Date(now - age).toISOString();
    latest.mockImplementation(async key => key === 'notifications_email' ? stale : receipt());
    expect(await notificationsHandler.runCheck()).toMatchObject({ status: 'degraded', checks: {
      verification: 'partial', observedFailure: false, email: { telemetryFresh: false, status: 'skipped' },
    } });
  });

  it('accepts the exact 15 minute boundary but never skipped or all-stale receipts', async () => {
    process.env.SENDGRID_API_KEY = credential();
    latest.mockResolvedValue(receipt('up', 15 * 60 * 1000));
    expect((await notificationsHandler.runCheck()).status).toBe('up');
    for (const value of [receipt('skipped'), receipt('down', 16 * 60 * 1000)]) {
      latest.mockResolvedValue(value);
      expect((await notificationsHandler.runCheck()).status).toBe('skipped');
    }
  });

  it('handles telemetry read failure without new I/O or propagating raw messages', async () => {
    const sensitive = privateData();
    latest.mockRejectedValue(new Error(sensitive.url.toString()));
    expect((await notificationsHandler.runCheck()).status).toBe('skipped');
    latest.mockResolvedValue({ ...receipt(), message: `${sensitive.email} ${sensitive.subject} ${sensitive.url}` });
    const output = JSON.stringify(await notificationsHandler.runCheck());
    for (const value of sensitive.values) expect(output).not.toContain(value);
    expect(from).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled(); expect(record).not.toHaveBeenCalled();
  });
});