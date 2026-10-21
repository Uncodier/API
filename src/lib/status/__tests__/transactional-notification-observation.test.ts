import { randomBytes, randomUUID } from 'node:crypto';
import sgMail from '@sendgrid/mail';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { recordTelemetry } from '@/lib/status/telemetry';
import { SendGridService, type SendEmailParams, type SendEmailResult } from '@/lib/services/sendgrid-service';
import { sendZavuTransactionalEmail } from '@/lib/services/email/ZavuTransactionalEmailService';
import type { TransactionalEmailDiagnostic } from '@/lib/services/email/transactional-email-config';

// Jest hoists these complete I/O mocks before the actual facade is imported.
// No SDK implementation, database client, .env loader or live network is used.
jest.mock('@sendgrid/mail', () => ({ __esModule: true, default: { setApiKey: jest.fn(), send: jest.fn() } }));
jest.mock('uuid', () => ({ v4: () => require('node:crypto').randomUUID() }));
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn(), rpc: jest.fn() } }));
jest.mock('@/lib/status/telemetry', () => ({ recordTelemetry: jest.fn() }));
jest.mock('@/lib/services/email/EmailSendService', () => ({ EmailSendService: { escapeHtml: (text: string) => text } }));
jest.mock('@/lib/services/email/ZavuTransactionalEmailService', () => ({ sendZavuTransactionalEmail: jest.fn() }));
jest.mock('@/lib/services/zavu/client', () => ({ zavuFetch: jest.fn(), sendChannelMessage: jest.fn() }));
jest.mock('@/lib/billing/licensed-resources', () => ({ getSiteLicensedResources: jest.fn(), requireLicensedChannel: jest.fn() }));

const originalEnv = process.env;
const originalFetch = global.fetch;
const credential = () => randomBytes(32).toString('hex');
const send = jest.mocked(sgMail.send);
const record = jest.mocked(recordTelemetry);
const zavu = jest.mocked(sendZavuTransactionalEmail);
let service: SendGridService;
let params: SendEmailParams;
let sensitive: string[];
let messageId: string;

function accepted(to: string, success = true): NonNullable<SendEmailResult['recipientResults']>[number] {
  const id = randomUUID();
  sensitive.push(id);
  return { to, success, messageId: id, status: success ? 'queued' : 'unconfirmed' };
}

function zavuAccepted(to = params.to as string): SendEmailResult {
  return { success: true, provider: 'zavu', statusCode: 202, recipientResults: [accepted(to)] };
}

function statuses() { return record.mock.calls.map(([key, status]) => [key, status]); }

beforeEach(() => {
  jest.resetAllMocks();
  process.env = { NODE_ENV: 'test', TRANSACTIONAL_EMAIL_PROVIDER: 'sendgrid', SENDGRID_API_KEY: credential(),
    SENDGRID_FROM_EMAIL: `${credential()}@example.invalid`, SENDGRID_FROM_NAME: credential(),
    ZAVUDEV_API_KEY: credential(), TRANSACTIONAL_EMAIL_FROM_EMAIL: `${credential()}@example.invalid`,
    TRANSACTIONAL_EMAIL_ZAVU_SITE_ID: randomUUID(), TRANSACTIONAL_EMAIL_ZAVU_CONNECTION_ID: randomUUID() };
  global.fetch = jest.fn(() => { throw new Error('Offline test forbids network'); });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  (SendGridService as any).instance = undefined;
  service = SendGridService.getInstance();
  const user = credential(); const password = credential(); const token = credential();
  const url = new URL('https://provider.example.invalid/error');
  url.username = user; url.password = password; url.searchParams.set('token', token);
  params = { to: `${credential()}@example.invalid`, subject: credential(), html: `<p>${credential()}</p>`,
    text: credential(), replyTo: `${credential()}@example.invalid`, categories: [credential()],
    customArgs: { token, privateUrl: url.toString() }, idempotencyKey: randomUUID(),
    attachments: [{ content: randomBytes(24).toString('base64'), filename: credential() }],
    dynamicTemplateData: { privateValue: credential() } };
  messageId = randomUUID();
  sensitive = [process.env.SENDGRID_API_KEY!, process.env.ZAVUDEV_API_KEY!, process.env.SENDGRID_FROM_EMAIL!,
    process.env.SENDGRID_FROM_NAME!, process.env.TRANSACTIONAL_EMAIL_FROM_EMAIL!, params.to as string,
    params.subject, params.html!, params.text!, params.replyTo!, params.categories![0],
    params.attachments![0].content, params.attachments![0].filename, params.dynamicTemplateData!.privateValue,
    params.idempotencyKey!, user, password, token, url.toString(), messageId];
  send.mockResolvedValue([{ statusCode: 202, headers: { 'x-message-id': messageId } }] as any);
  record.mockResolvedValue(undefined);
  zavu.mockResolvedValue(zavuAccepted());
});

afterEach(() => {
  expect(global.fetch).not.toHaveBeenCalled();
  expect(supabaseAdmin.from).not.toHaveBeenCalled();
  expect(supabaseAdmin.rpc).not.toHaveBeenCalled();
  const labels = {
    up: 'Notification email accepted by provider; mailbox delivery unconfirmed',
    degraded: 'Notification email partially accepted by provider; mailbox delivery unconfirmed',
    down: 'Notification email acceptance failed or unconfirmed',
  };
  for (const [key, status, message, latency] of record.mock.calls) {
    expect(key).toBe('notifications_email');
    expect(message).toBe(labels[status as keyof typeof labels]);
    expect(typeof latency).toBe('number');
    expect(latency).toBeGreaterThanOrEqual(0);
  }
  const output = JSON.stringify([...record.mock.calls, ...(console.log as jest.Mock).mock.calls,
    ...(console.error as jest.Mock).mock.calls, ...(console.warn as jest.Mock).mock.calls]);
  for (const value of sensitive) expect(output).not.toContain(value);
  process.env = originalEnv; global.fetch = originalFetch; jest.restoreAllMocks();
});

describe('actual SendGrid facade acceptance, not a notification-category proxy', () => {
  it.each([200, 202, 204, 299])('observes real HTTP %i acceptance preserving request and return', async statusCode => {
    send.mockResolvedValue([{ statusCode, headers: { 'x-message-id': messageId } }] as any);
    expect(await service.sendEmail(params)).toEqual({ success: true, provider: 'sendgrid', statusCode, messageId });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: params.to, subject: params.subject,
      html: params.html, text: params.text, categories: params.categories, customArgs: params.customArgs,
      attachments: params.attachments, replyTo: params.replyTo, mailSettings: { sandboxMode: { enable: false } } }));
    expect(record).toHaveBeenCalledWith('notifications_email', 'up',
      'Notification email accepted by provider; mailbox delivery unconfirmed', expect.any(Number));
    expect(zavu).not.toHaveBeenCalled();
  });

  const categories: Array<[string[] | undefined]> = [[undefined], [[]], [['welcome']], [['password_reset']], [['notifications']]];
  it.each(categories)('covers all platform transactional categories: %j', async category => {
    expect((await service.sendEmail({ ...params, categories: category })).success).toBe(true);
    expect(statuses()).toEqual([['notifications_email', 'up']]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('retains dynamic-template fields and legacy message-id fallback', async () => {
    const templateId = credential(); sensitive.push(templateId);
    send.mockResolvedValue([{ statusCode: 202, headers: {} }] as any);
    const result = await service.sendEmail({ ...params, templateId });
    expect(result).toMatchObject({ success: true, provider: 'sendgrid', statusCode: 202 });
    expect(typeof result.messageId).toBe('string');
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ templateId, dynamicTemplateData: params.dynamicTemplateData }));
    expect(statuses()).toEqual([['notifications_email', 'up']]);
  });

  it('records accepted multiple recipients without duplicating the existing provider dispatch', async () => {
    const second = `${credential()}@example.invalid`; sensitive.push(second);
    expect((await service.sendEmail({ ...params, to: [params.to as string, second] })).success).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(statuses()).toEqual([['notifications_email', 'up']]);
  });

  const invalidRecipients: Array<[unknown]> = [[''], [[]], [['']], [[' ']], ['malformed'], [['bad', 'valid@example.invalid']], [undefined], [null]];
  it.each(invalidRecipients)(
    'does not report no/malformed-recipient success evidence: %j', async to => {
      expect((await service.sendEmail({ ...params, to: to as any })).success).toBe(true);
      expect(send).toHaveBeenCalledTimes(1); // Observation does not alter legacy dispatch.
      expect(record).not.toHaveBeenCalled();
    });

  it.each([true, false])('skips sandbox evidence even when SDK success=%s', async success => {
    service.initialize({ sandboxMode: true });
    if (!success) send.mockRejectedValue({ response: { statusCode: 503 }, message: sensitive[0] });
    expect((await service.sendEmail(params)).success).toBe(success);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ mailSettings: { sandboxMode: { enable: true } } }));
    expect(record).not.toHaveBeenCalled();
  });

  it.each([undefined, null, '202', 0, 199, 300, 400, 422])('does not mark invalid/nonaccepted response %j up', async statusCode => {
    send.mockResolvedValue([{ statusCode, headers: {} }] as any);
    expect((await service.sendEmail(params)).success).toBe(true);
    expect(statuses()).toEqual([['notifications_email', 'degraded']]);
  });

  const malformed: Array<[unknown]> = [[[]], [[undefined]], [[{}]], [[{ statusCode: 202 }]]];
  it.each(malformed)('does not mark a malformed SDK response up: %j', async response => {
    send.mockResolvedValue(response as any);
    expect((await service.sendEmail(params)).success).toBe(false);
    expect(statuses()).toEqual([['notifications_email', 'degraded']]);
  });

  it.each([401, 403, 429, 500, 502, 503, 599])('records actual attempted provider HTTP %i down', async statusCode => {
    send.mockRejectedValue({ response: { statusCode, body: { errors: [{ message: sensitive[0] }] } } });
    expect(await service.sendEmail(params)).toMatchObject({ success: false, statusCode, error: sensitive[0] });
    expect(statuses()).toEqual([['notifications_email', 'down']]);
  });

  it('keeps the legacy SDK resolved result while marking actual nonaccepted 503 down', async () => {
    send.mockResolvedValue([{ statusCode: 503, headers: { 'x-message-id': messageId } }] as any);
    expect(await service.sendEmail(params)).toEqual({ success: true, provider: 'sendgrid', messageId, statusCode: 503 });
    expect(statuses()).toEqual([['notifications_email', 'down']]);
  });

  it.each([400, 402, 404, 422, undefined])('ambiguous/input rejection %j is degraded, not invented providerdown', async status => {
    send.mockRejectedValue(Object.assign(new Error(params.customArgs!.privateUrl), { status }));
    expect(await service.sendEmail(params)).toMatchObject({ success: false, statusCode: 500, error: params.customArgs!.privateUrl });
    expect(statuses()).toEqual([['notifications_email', 'degraded']]);
  });

  it.each(['missing-key', 'invalid-provider'])('does not mark local %s preflight as provider downtime', async invalid => {
    if (invalid === 'missing-key') delete process.env.SENDGRID_API_KEY;
    else process.env.TRANSACTIONAL_EMAIL_PROVIDER = credential();
    expect((await service.sendEmail(params)).success).toBe(false);
    expect(send).not.toHaveBeenCalled(); expect(zavu).not.toHaveBeenCalled(); expect(record).not.toHaveBeenCalled();
  });

  it.each([false, true])('does not mark caller cancellation after dispatch=%s as down', async afterDispatch => {
    const controller = new AbortController();
    if (afterDispatch) send.mockImplementation(async () => { controller.abort(); throw controller.signal.reason; });
    else controller.abort();
    expect((await service.sendEmail({ ...params, signal: controller.signal })).success).toBe(false);
    expect(send).toHaveBeenCalledTimes(afterDispatch ? 1 : 0); expect(record).not.toHaveBeenCalled();
  });

  it('keeps an attempted ambiguous timeout degraded', async () => {
    send.mockRejectedValue(new DOMException(credential(), 'TimeoutError'));
    expect((await service.sendEmail(params)).success).toBe(false);
    expect(statuses()).toEqual([['notifications_email', 'degraded']]);
  });

  it('awaits telemetry and catches its rejection without changing acceptance or retrying', async () => {
    let reject!: (error: Error) => void;
    record.mockImplementation(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    let settled = false;
    const pending = service.sendEmail(params).then(result => { settled = true; return result; });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(record).toHaveBeenCalledTimes(1); expect(settled).toBe(false);
    reject(new Error(params.customArgs!.privateUrl));
    expect(await pending).toEqual({ success: true, provider: 'sendgrid', messageId, statusCode: 202 });
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('Zavu results are awaited at the actual facade without modifying request logic', () => {
  beforeEach(() => { process.env.TRANSACTIONAL_EMAIL_PROVIDER = 'zavu'; });

  it('waits for actual per-recipient acceptance and returns the original object', async () => {
    let resolve!: (result: SendEmailResult) => void;
    zavu.mockImplementation(() => new Promise<SendEmailResult>(done => { resolve = done; }));
    const pending = service.sendEmail(params);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(zavu).toHaveBeenCalledWith(params); expect(record).not.toHaveBeenCalled();
    const result = zavuAccepted(); resolve(result);
    expect(await pending).toBe(result);
    expect(statuses()).toEqual([['notifications_email', 'up']]);
    expect(send).not.toHaveBeenCalled(); expect(sgMail.setApiKey).not.toHaveBeenCalled();
  });

  it.each(['queued', 'sending', 'sent', 'delivered', 'read'])('requires actual accepted state %s', async status => {
    const result = zavuAccepted(); result.recipientResults![0].status = status;
    zavu.mockResolvedValue(result);
    expect(await service.sendEmail(params)).toBe(result);
    expect(statuses()).toEqual([['notifications_email', 'up']]);
  });

  const unknownResults: Array<[SendEmailResult]> = [
    [{ success: true, provider: 'zavu', statusCode: 202 }],
    [{ success: true, provider: 'zavu', statusCode: 202, recipientResults: [] }],
    [{ success: false, provider: 'zavu', statusCode: 502 }],
  ];
  it.each(unknownResults)('incomplete/unknown result %j is neither up nor providerdown', async result => {
    zavu.mockResolvedValue(result);
    expect(await service.sendEmail(params)).toBe(result);
    expect(statuses()).toEqual([['notifications_email', 'degraded']]);
  });

  it.each(['missing-id', 'bad-status', 'wrong-recipient', 'false-success', 'bad-http'])('does not accept incomplete evidence: %s', async invalid => {
    const result = zavuAccepted(); const recipient = result.recipientResults![0];
    if (invalid === 'missing-id') recipient.messageId = undefined;
    if (invalid === 'bad-status') recipient.status = 'unconfirmed';
    if (invalid === 'wrong-recipient') recipient.to = `${credential()}@example.invalid`;
    if (invalid === 'false-success') recipient.success = false;
    if (invalid === 'bad-http') result.statusCode = 502;
    zavu.mockResolvedValue(result);
    expect(await service.sendEmail(params)).toBe(result);
    expect(statuses()).toEqual([['notifications_email', 'degraded']]);
  });

  it('reports partial acceptance degraded while retaining aggregate failure', async () => {
    const second = `${credential()}@example.invalid`; sensitive.push(second);
    const result: SendEmailResult = { success: false, provider: 'zavu', statusCode: 502,
      recipientResults: [accepted(params.to as string), { ...accepted(second, false),
        diagnostic: { stage: 'dispatch', code: 'provider_unavailable', httpStatus: 503 } }] };
    zavu.mockResolvedValue(result);
    expect(await service.sendEmail({ ...params, to: [params.to as string, second] })).toBe(result);
    expect(statuses()).toEqual([['notifications_email', 'degraded']]);
  });

  const localDiagnostics: Array<[TransactionalEmailDiagnostic['stage'], TransactionalEmailDiagnostic['code']]> = [
    ['configuration', 'missing_configuration'], ['validation', 'invalid_request'], ['validation', 'unsupported_feature'],
    ['sender_resolution', 'connection_mismatch'], ['sender_verification', 'sender_not_verified'],
  ];
  it.each(localDiagnostics)('does not mark local %s/%s as providerdown', async (stage, code) => {
    const result: SendEmailResult = { success: false, provider: 'zavu', statusCode: 502,
      diagnostic: { stage, code }, error: sensitive[0] };
    zavu.mockResolvedValue(result);
    expect(await service.sendEmail(params)).toBe(result);
    expect(record).not.toHaveBeenCalled();
  });

  it.each([401, 403, 429, 500, 502, 503, 599])('uses actual dispatch provider diagnostic HTTP %i, not synthetic 502', async httpStatus => {
    const result: SendEmailResult = { success: false, provider: 'zavu', statusCode: 502,
      diagnostic: { stage: 'dispatch', code: 'provider_unavailable', httpStatus }, error: params.customArgs!.privateUrl };
    zavu.mockResolvedValue(result);
    expect(await service.sendEmail(params)).toBe(result);
    expect(statuses()).toEqual([['notifications_email', 'down']]);
  });

  it('uses provider HTTP sender-verification failure evidence', async () => {
    zavu.mockResolvedValue({ success: false, provider: 'zavu', statusCode: 502,
      diagnostic: { stage: 'sender_verification', code: 'provider_auth_failed', httpStatus: 403 } });
    await service.sendEmail(params);
    expect(statuses()).toEqual([['notifications_email', 'down']]);
  });

  it.each([undefined, 400, 402, 404, 422])('does not infer providerdown from synthetic 502 and diagnostic HTTP %j', async httpStatus => {
    zavu.mockResolvedValue({ success: false, provider: 'zavu', statusCode: 502,
      diagnostic: { stage: 'dispatch', code: 'provider_unavailable', httpStatus }, error: sensitive[0] });
    expect((await service.sendEmail(params)).success).toBe(false);
    expect(statuses()).toEqual([['notifications_email', 'degraded']]);
  });

  it('catches async provider rejection through the facade error return', async () => {
    zavu.mockRejectedValue(Object.assign(new Error(params.customArgs!.privateUrl), { status: 503 }));
    expect(await service.sendEmail(params)).toMatchObject({ success: false, error: params.customArgs!.privateUrl });
    expect(statuses()).toEqual([['notifications_email', 'down']]);
  });

  it('does not invent acceptance for no recipients even with vacuous aggregate success', async () => {
    const result: SendEmailResult = { success: true, provider: 'zavu', statusCode: 202, recipientResults: [] };
    zavu.mockResolvedValue(result);
    expect(await service.sendEmail({ ...params, to: [] })).toBe(result);
    expect(record).not.toHaveBeenCalled(); expect(zavu).toHaveBeenCalledTimes(1);
  });

  it('skips user cancellation returned as unconfirmed', async () => {
    const controller = new AbortController();
    zavu.mockImplementation(async () => { controller.abort(); return { success: false, provider: 'zavu', statusCode: 502,
      diagnostic: { stage: 'dispatch', code: 'deadline_exceeded' } }; });
    expect((await service.sendEmail({ ...params, signal: controller.signal })).success).toBe(false);
    expect(record).not.toHaveBeenCalled();
  });

  it('awaits and safely swallows telemetry rejection without retry/provider switch', async () => {
    const result = zavuAccepted(); zavu.mockResolvedValue(result);
    let reject!: (error: Error) => void;
    record.mockImplementation(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    let settled = false;
    const pending = service.sendEmail(params).then(value => { settled = true; return value; });
    for (let i = 0; i < 16; i++) await Promise.resolve();
    expect(record).toHaveBeenCalledTimes(1); expect(settled).toBe(false);
    reject(new Error(params.customArgs!.privateUrl));
    expect(await pending).toBe(result);
    expect(zavu).toHaveBeenCalledTimes(1); expect(send).not.toHaveBeenCalled();
    expect(statuses()).toEqual([['notifications_email', 'up']]);
  });
});