import { randomBytes } from 'node:crypto';
import sgMail from '@sendgrid/mail';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { SendGridService } from '@/lib/services/sendgrid-service';
import { getTransactionalEmailProvider } from '../transactional-email-config';

jest.mock('@sendgrid/mail', () => ({ __esModule: true, default: { setApiKey: jest.fn(), send: jest.fn() } }));
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('../EmailSendService', () => ({ EmailSendService: { escapeHtml: (text: string) => text } }));

const originalEnv = process.env;
const originalFetch = global.fetch;
const service = SendGridService.getInstance();
const from = 'hi@example.invalid';
const to = 'recipient@example.invalid';
let abortSignal: jest.Mock;
let query: { select: jest.Mock; eq: jest.Mock; maybeSingle: jest.Mock; abortSignal: jest.Mock };
let connection: any;

function json(status: number, payload: unknown): Response {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) } as Response;
}

function messagePosts(): any[] {
  return (global.fetch as jest.Mock).mock.calls.filter(([url, init]) => url.endsWith('/messages') && init.method === 'POST');
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env = {
    NODE_ENV: 'test',
    TRANSACTIONAL_EMAIL_PROVIDER: 'zavu', TRANSACTIONAL_EMAIL_FROM_EMAIL: from,
    TRANSACTIONAL_EMAIL_ZAVU_SITE_ID: 'site-internal', TRANSACTIONAL_EMAIL_ZAVU_CONNECTION_ID: 'connection-internal',
    TRANSACTIONAL_EMAIL_ZAVU_SENDER_ID: 'sender-internal', ZAVUDEV_API_KEY: randomBytes(32).toString('hex'),
  };
  connection = {
    id: 'connection-internal', type: 'email', status: 'connected', zavu_sender_id: 'sender-internal',
    metadata: { from_address: from, email_domain_id: 'domain-internal' },
  };
  abortSignal = jest.fn();
  query = { select: jest.fn(), eq: jest.fn(), maybeSingle: jest.fn(), abortSignal };
  query.select.mockReturnValue(query); query.eq.mockReturnValue(query); abortSignal.mockReturnValue(query);
  query.maybeSingle.mockImplementation(async () => ({ data: { channels: { connections: [connection] } }, error: null }));
  (supabaseAdmin.from as jest.Mock).mockReturnValue(query);
  global.fetch = jest.fn().mockImplementation(async (url: string) => {
    if (url.includes('/senders/')) return json(200, { sender: { id: 'sender-internal', emailAddress: from, channels: ['email'] } });
    if (url.includes('/email-domains/')) return json(200, { domain: { id: 'domain-internal', status: 'verified' } });
    return json(202, { message: { id: 'message-confirmed', status: 'queued' } });
  });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  process.env = originalEnv;
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

it('sends existing facade calls with the pinned Zavu account without requiring SendGrid', async () => {
  service.initialize();
  const result = await service.sendEmail({ to, subject: 'Notice', html: '<h1>Welcome</h1><p>Your account.</p>',
    from: { email: 'legacy@example.invalid', name: 'Old override' }, categories: ['notice'], customArgs: { siteId: 'tenant-other' } });
  expect(result).toMatchObject({ success: true, provider: 'zavu', messageId: 'message-confirmed', status: 'queued', statusCode: 202 });
  expect(sgMail.send).not.toHaveBeenCalled(); expect(sgMail.setApiKey).not.toHaveBeenCalled();
  expect(query.eq).toHaveBeenCalledWith('site_id', 'site-internal');
  const [, init] = messagePosts()[0]; const body = JSON.parse(init.body);
  expect(init.headers['Zavu-Sender']).toBe('sender-internal');
  expect(body).toMatchObject({ to, channel: 'email', subject: 'Notice', htmlBody: '<h1>Welcome</h1><p>Your account.</p>',
    metadata: { siteId: 'tenant-other', categories: '["notice"]', purpose: 'transactional' } });
  expect(body.text).toContain('Welcome'); expect(body.text).toContain('Your account.');
  expect(body).not.toHaveProperty('from'); expect(body.idempotencyKey).toMatch(/^transactional-[a-f0-9]{64}$/);
});

it('preserves supplied text, reply-to, attachments and inline CID', async () => {
  const content = Buffer.from('synthetic document').toString('base64');
  await service.sendEmail({ to, subject: 'Receipt', text: 'Exact text', html: '<img src="cid:logo">',
    replyTo: 'support@example.invalid', attachments: [{ content, filename: 'logo.png', type: 'image/png', disposition: 'inline', contentId: 'logo' }] });
  expect(JSON.parse(messagePosts()[0][1].body)).toMatchObject({ text: 'Exact text', replyTo: 'support@example.invalid',
    attachments: [{ content, filename: 'logo.png', content_type: 'image/png', content_id: 'logo' }] });
});

it('uses stable payload-bound keys for retries without exposing auth values', async () => {
  const token = randomBytes(24).toString('hex'); const operation = randomBytes(24).toString('hex');
  const params = { to, subject: 'Auth', text: token, idempotencyKey: operation };
  await service.sendEmail(params); await service.sendEmail(params);
  const keys = messagePosts().map(([, init]) => JSON.parse(init.body).idempotencyKey);
  expect(keys[0]).toBe(keys[1]); expect(keys[0]).not.toContain(token); expect(keys[0]).not.toContain(operation);
  await service.sendEmail({ ...params, text: 'different content' });
  expect(JSON.parse(messagePosts()[2][1].body).idempotencyKey).not.toBe(keys[0]);
});

it('accepts a documented HTTP 409 message replay without a second provider or retry', async () => {
  const fetchMock = global.fetch as jest.Mock;
  const implementation = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url, init) => url.endsWith('/messages')
    ? json(409, { message: { id: 'original-message', status: 'delivered' } }) : implementation(url, init));
  expect(await service.sendEmail({ to, subject: 'Auth', text: 'Code', idempotencyKey: 'operation' }))
    .toMatchObject({ success: true, messageId: 'original-message', status: 'delivered' });
  expect(messagePosts()).toHaveLength(1); expect(sgMail.send).not.toHaveBeenCalled();
});

it.each([undefined, 'failed', 'unknown'])('never claims acceptance for state %s', async status => {
  const fetchMock = global.fetch as jest.Mock; const implementation = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url, init) => url.endsWith('/messages')
    ? json(202, { message: { id: 'message-1', status } }) : implementation(url, init));
  expect(await service.sendEmail({ to, subject: 'Notice', text: 'Body' })).toMatchObject({ success: false });
});

it('fails closed for a provider response without a real message ID', async () => {
  const fetchMock = global.fetch as jest.Mock; const implementation = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url, init) => url.endsWith('/messages')
    ? json(202, { message: { status: 'queued' } }) : implementation(url, init));
  expect(await service.sendEmail({ to, subject: 'Notice', text: 'Body' })).toMatchObject({ success: false });
});

it('returns per-recipient partial results with distinct keys and does not resend successful recipients', async () => {
  const fetchMock = global.fetch as jest.Mock; const implementation = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url, init) => url.endsWith('/messages') && JSON.parse(init.body).to === 'second@example.invalid'
    ? json(429, { code: 'daily_limit_exceeded' }) : implementation(url, init));
  const result = await service.sendEmail({ to: [to, to, 'second@example.invalid'], subject: 'Notice', text: 'Body' });
  expect(result.success).toBe(false); expect(result.messageId).toBeUndefined();
  expect(result.recipientResults).toEqual([expect.objectContaining({ to, success: true }), expect.objectContaining({ to: 'second@example.invalid', success: false })]);
  const posts = messagePosts(); expect(posts).toHaveLength(2);
  expect(JSON.parse(posts[0][1].body).idempotencyKey).not.toBe(JSON.parse(posts[1][1].body).idempotencyKey);
  expect(sgMail.send).not.toHaveBeenCalled();
});

it.each(['from', 'status', 'sender', 'type', 'duplicates', 'missing'])('rejects unavailable/mismatched connection: %s', async kind => {
  if (kind === 'from') connection.metadata.from_address = 'other@example.invalid';
  if (kind === 'status') connection.status = 'pending';
  if (kind === 'sender') connection.zavu_sender_id = 'other-sender';
  if (kind === 'type') connection.type = 'telegram';
  if (kind === 'duplicates' || kind === 'missing') query.maybeSingle.mockResolvedValue({ data: { channels: { connections: kind === 'duplicates' ? [connection, connection] : [] } }, error: null });
  expect(await service.sendEmail({ to, subject: 'Notice', text: 'Body' })).toMatchObject({ success: false });
  expect(messagePosts()).toHaveLength(0);
});

it('fails closed on database failure or unverified live domain', async () => {
  query.maybeSingle.mockResolvedValueOnce({ data: null, error: { message: 'offline' } });
  expect((await service.sendEmail({ to, subject: 'Notice', text: 'Body' })).success).toBe(false);
  const fetchMock = global.fetch as jest.Mock; const implementation = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url, init) => url.includes('/email-domains/')
    ? json(200, { domain: { id: 'domain-internal', status: 'pending' } }) : implementation(url, init));
  expect((await service.sendEmail({ to, subject: 'Notice', text: 'Body' })).success).toBe(false);
  expect(messagePosts()).toHaveLength(0);
});

it.each([{ cc: to }, { bcc: to }, { templateId: 'dynamic' }, { dynamicTemplateData: {} }, { sendAt: 123 }])
  ('rejects unsupported SendGrid features before sending: %j', async feature => {
    expect((await service.sendEmail({ to, subject: 'Notice', text: 'Body', ...feature })).success).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

it.each([{ to: [] }, { to: 'invalid' }, { subject: '' }, { html: '', text: '' }, { replyTo: 'invalid' }])
  ('validates the entire request before sending: %j', async invalid => {
    expect((await service.sendEmail({ to, subject: 'Notice', text: 'Body', ...invalid })).success).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

it('does not leak a provider-echoed secret into logs or results and never falls back', async () => {
  const sensitive = randomBytes(32).toString('hex');
  (global.fetch as jest.Mock).mockRejectedValue(new Error(sensitive));
  const result = await service.sendEmail({ to, subject: 'Notice', text: 'Body' });
  expect(result.success).toBe(false);
  expect(JSON.stringify(result)).not.toContain(sensitive);
  expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain(sensitive);
  expect(sgMail.send).not.toHaveBeenCalled();
});

it('redacts credential echoes in HTTP failures too', async () => {
  const sensitive = randomBytes(32).toString('hex');
  (global.fetch as jest.Mock).mockResolvedValue(json(401, { message: sensitive }));
  const result = await service.sendEmail({ to, subject: 'Notice', text: 'Body' });
  expect(result.success).toBe(false);
  expect(JSON.stringify(result)).not.toContain(sensitive);
  expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain(sensitive);
});

it('does not interpret a malformed 409 conflict as a successful replay', async () => {
  const fetchMock = global.fetch as jest.Mock; const implementation = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url, init) => url.endsWith('/messages')
    ? json(409, { error: 'conflict' }) : implementation(url, init));
  expect((await service.sendEmail({ to, subject: 'Notice', text: 'Body', idempotencyKey: 'operation' })).success).toBe(false);
  expect(messagePosts()).toHaveLength(1); expect(sgMail.send).not.toHaveBeenCalled();
});

it('does not replay an old key unless this send supplied idempotency', async () => {
  // The central helper's generic 409 opt-in is also guarded in client regressions.
  const { zavuFetch } = await import('@/lib/services/zavu/client');
  (global.fetch as jest.Mock).mockResolvedValue(json(409, { message: { id: 'old-message', status: 'delivered' } }));
  await expect(zavuFetch('/senders/sender-internal', { method: 'PATCH' }, { acceptMessageReplay: true }))
    .rejects.toMatchObject({ status: 409 });
});

it('rejects missing pins/configuration instead of using the project default sender', async () => {
  delete process.env.TRANSACTIONAL_EMAIL_ZAVU_CONNECTION_ID;
  expect((await service.sendEmail({ to, subject: 'Notice', text: 'Body' })).success).toBe(false);
  expect(global.fetch).not.toHaveBeenCalled(); expect(supabaseAdmin.from).not.toHaveBeenCalled();
});

it('refuses a live sender whose address changed after site configuration', async () => {
  const fetchMock = global.fetch as jest.Mock; const implementation = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url, init) => url.includes('/senders/')
    ? json(200, { sender: { id: 'sender-internal', emailAddress: 'other@example.invalid', channels: ['email'] } }) : implementation(url, init));
  expect((await service.sendEmail({ to, subject: 'Notice', text: 'Body' })).success).toBe(false);
  expect(messagePosts()).toHaveLength(0);
});

it.each([
  { content: 'not base64!', filename: 'doc.txt' },
  { content: 'YQ==', filename: 'image.png', disposition: 'inline' as const },
])('rejects invalid or unsupported attachments before any sends', async attachment => {
  expect((await service.sendEmail({ to, subject: 'Notice', text: 'Body', attachments: [attachment] })).success).toBe(false);
  expect(global.fetch).not.toHaveBeenCalled();
});

it('propagates a shared deadline and refuses an expired deadline', async () => {
  const controller = new AbortController();
  await service.sendEmail({ to, subject: 'Notice', text: 'Body', signal: controller.signal });
  expect(abortSignal).toHaveBeenCalledWith(controller.signal);
  expect(messagePosts()[0][1].signal).toBe(controller.signal);
  controller.abort();
  expect((await service.sendEmail({ to, subject: 'Notice', text: 'Body', signal: controller.signal })).success).toBe(false);
  expect(messagePosts()).toHaveLength(1);
});

it('checks Zavu health without initializing SendGrid', async () => {
  expect(await service.healthCheck()).toBe(true); expect(messagePosts()).toHaveLength(0);
  expect(sgMail.setApiKey).not.toHaveBeenCalled();
});

it('defaults to SendGrid, preserves legacy options and can switch back to Zavu', async () => {
  delete process.env.TRANSACTIONAL_EMAIL_PROVIDER; delete process.env.TRANSACTIONAL_EMAIL_FROM_EMAIL;
  process.env.SENDGRID_API_KEY = randomBytes(32).toString('hex');
  expect(getTransactionalEmailProvider()).toBe('sendgrid');
  (sgMail.send as jest.Mock).mockResolvedValue([{ statusCode: 202, headers: { 'x-message-id': 'sendgrid-message' } }]);
  const params = { to: [to], subject: 'Legacy', html: '<p>Legacy</p>', from: { email: 'legacy@example.invalid', name: 'Legacy' },
    cc: 'cc@example.invalid', bcc: 'bcc@example.invalid', replyTo: 'reply@example.invalid', sendAt: 123,
    templateId: 'template', dynamicTemplateData: { name: 'Name' }, categories: ['legacy'], customArgs: { site: 'site' } };
  expect(await service.sendEmail(params)).toMatchObject({ success: true, provider: 'sendgrid', messageId: 'sendgrid-message' });
  expect(sgMail.send).toHaveBeenCalledWith(expect.objectContaining(params));
  expect(global.fetch).not.toHaveBeenCalled();
  process.env.TRANSACTIONAL_EMAIL_FROM_EMAIL = from;
  process.env.TRANSACTIONAL_EMAIL_FROM_NAME = 'Configured Name';
  await service.sendEmail({ to, subject: 'Override', text: 'Body', from: params.from });
  expect(sgMail.send).toHaveBeenLastCalledWith(expect.objectContaining({ from: params.from }));
  expect(service.getConfig().defaultFromEmail).not.toBe(from);
  process.env.TRANSACTIONAL_EMAIL_PROVIDER = 'zavu';
  expect(service.getConfig()).toMatchObject({ defaultFromEmail: from, defaultFromName: 'Configured Name' });
  expect((await service.sendEmail({ to, subject: 'Zavu', text: 'Body' })).provider).toBe('zavu');
  expect(sgMail.send).toHaveBeenCalledTimes(2);
});

it('rejects an invalid provider instead of silently choosing another transport', async () => {
  process.env.TRANSACTIONAL_EMAIL_PROVIDER = 'typo';
  expect((await service.sendEmail({ to, subject: 'Notice', text: 'Body' })).success).toBe(false);
  expect(global.fetch).not.toHaveBeenCalled(); expect(sgMail.send).not.toHaveBeenCalled();
});

it('never dispatches SendGrid after an auth deadline has expired', async () => {
  process.env.TRANSACTIONAL_EMAIL_PROVIDER = 'sendgrid';
  process.env.SENDGRID_API_KEY = randomBytes(32).toString('hex');
  const controller = new AbortController(); controller.abort();
  const result = await service.sendEmail({ to, subject: 'Auth', text: 'Body', signal: controller.signal });
  expect(result.success).toBe(false);
  expect(sgMail.send).not.toHaveBeenCalled(); expect(global.fetch).not.toHaveBeenCalled();
});
