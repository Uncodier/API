import { createHmac, randomBytes } from 'node:crypto';
import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import sgMail from '@sendgrid/mail';
import { POST } from '../route';

// Keep the real recovery template, locale rules, facade and Zavu transport.
// Only database/provider I/O is mocked; never load developer .env or send mail.
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('@sendgrid/mail', () => ({ __esModule: true, default: { setApiKey: jest.fn(), send: jest.fn() } }));
jest.mock('@/lib/services/email/EmailSendService', () => ({ EmailSendService: {} }));

const originalEnv = process.env;
const originalFetch = global.fetch;
let key: Buffer;
let token: string;
let hash: string;
const address = 'user@example.invalid';
let connection: any;

beforeEach(() => {
  jest.clearAllMocks();
  key = randomBytes(32); token = randomBytes(6).toString('hex'); hash = randomBytes(32).toString('hex');
  process.env = { NODE_ENV: 'test', SEND_EMAIL_HOOK_SECRET: `v1,whsec_${key.toString('base64')}`,
    NEXT_PUBLIC_SUPABASE_URL: 'https://auth.example.invalid', TRANSACTIONAL_EMAIL_PROVIDER: 'zavu',
    ZAVUDEV_API_KEY: randomBytes(32).toString('hex'), TRANSACTIONAL_EMAIL_FROM_EMAIL: 'hi@example.invalid',
    TRANSACTIONAL_EMAIL_ZAVU_SITE_ID: 'internal-site', TRANSACTIONAL_EMAIL_ZAVU_CONNECTION_ID: 'internal-connection' };
  connection = { id: 'internal-connection', type: 'email', status: 'connected', zavu_sender_id: 'internal-sender',
    metadata: { from_address: 'hi@example.invalid', email_domain_id: 'internal-domain' } };
  const q: any = { select: () => q, eq: () => q, abortSignal: () => q,
    maybeSingle: async () => ({ data: { channels: { connections: [connection] } }, error: null }) };
  (supabaseAdmin.from as jest.Mock).mockReturnValue(q);
  global.fetch = jest.fn().mockImplementation(async (url: string) => {
    const body = url.includes('/senders/') ? { sender: { id: 'internal-sender', emailAddress: 'hi@example.invalid', channels: ['email'] } }
      : url.includes('/email-domains/') ? { domain: { id: 'internal-domain', status: 'verified' } }
      : { message: { id: 'recovery-message', status: 'queued' } };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) } as Response;
  });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => { process.env = originalEnv; global.fetch = originalFetch; jest.restoreAllMocks(); });

function recoveryRequest(locale = 'es', action = 'recovery'): NextRequest {
  const body = JSON.stringify({ user: { id: 'user-1', email: address, user_metadata: { locale } },
    email_data: { email_action_type: action, token, token_hash: hash, redirect_to: 'https://app.example.invalid/reset-password' } });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', key).update(`recovery-event.${timestamp}.${body}`).digest('base64');
  return new NextRequest('https://api.example.invalid/api/auth/send-email-hook', { method: 'POST', body,
    headers: { 'webhook-id': 'recovery-event', 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${signature}` } });
}

it.each(['en', 'es', 'fr', 'de', 'ja'])('accepts forgot-password with the real %s template and configured Zavu sender', async locale => {
  const response = await POST(recoveryRequest(locale));
  expect(response.status).toBe(200);
  const posts = (global.fetch as jest.Mock).mock.calls.filter(([url]) => url.endsWith('/messages'));
  expect(posts).toHaveLength(1);
  const body = JSON.parse(posts[0][1].body);
  expect(body.subject.trim()).not.toBe('');
  expect(body.subject.length).toBeLessThanOrEqual(998);
  expect(body.htmlBody).toContain(hash); expect(body.text).toContain(hash);
  expect(body.to).toBe(address); expect(body.channel).toBe('email');
  expect(body.metadata.authAction).toBe('recovery');
  expect(JSON.stringify(body.metadata)).not.toContain(token); expect(JSON.stringify(body.metadata)).not.toContain(hash);
  expect(sgMail.send).not.toHaveBeenCalled();
});

it('accepts reauthentication OTP through the same real template and transport', async () => {
  expect((await POST(recoveryRequest('es', 'reauthentication'))).status).toBe(200);
  const posts = (global.fetch as jest.Mock).mock.calls.filter(([url]) => url.endsWith('/messages'));
  expect(posts).toHaveLength(1);
  const body = JSON.parse(posts[0][1].body);
  expect(body.htmlBody).toContain(token); expect(body.text).toContain(token);
  expect(body.htmlBody).not.toContain(hash); expect(body.text).not.toContain(hash);
  expect(body.channel).toBe('email'); expect(body.metadata.authAction).toBe('reauthentication');
  expect(JSON.stringify(body.metadata)).not.toContain(token);
  expect(JSON.stringify(body.metadata)).not.toContain(hash);
  expect(sgMail.send).not.toHaveBeenCalled();
});

it.each(['TRANSACTIONAL_EMAIL_ZAVU_SITE_ID', 'TRANSACTIONAL_EMAIL_ZAVU_CONNECTION_ID', 'ZAVUDEV_API_KEY'])(
  'reproduces an immediate recovery 500 with zero external requests when production misses %s', async variable => {
    delete process.env[variable];
    const response = await POST(recoveryRequest());
    expect(response.status).toBe(500);
    expect(global.fetch).not.toHaveBeenCalled(); expect(supabaseAdmin.from).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith('[auth/send-email-hook] Transactional email send failed', {
      provider: 'zavu', action: 'recovery', stage: 'configuration', code: 'missing_configuration', missingConfiguration: [variable],
    });
    const output = JSON.stringify({ response: await response.json(), logs: (console.error as jest.Mock).mock.calls });
    for (const sensitive of [token, hash, address, process.env.SEND_EMAIL_HOOK_SECRET!, process.env.ZAVUDEV_API_KEY].filter(Boolean)) {
      expect(output).not.toContain(sensitive);
    }
  },
);

it('reports a local connection mismatch without exposing account identities', async () => {
  connection.status = 'pending';
  const response = await POST(recoveryRequest());
  expect(response.status).toBe(500); expect(global.fetch).not.toHaveBeenCalled();
  expect(console.error).toHaveBeenCalledWith('[auth/send-email-hook] Transactional email send failed', {
    provider: 'zavu', action: 'recovery', stage: 'sender_resolution', code: 'connection_mismatch',
  });
});

it('identifies a deployment that omitted the provider and defaults to unconfigured SendGrid', async () => {
  delete process.env.TRANSACTIONAL_EMAIL_PROVIDER;
  delete process.env.SENDGRID_API_KEY;
  expect((await POST(recoveryRequest())).status).toBe(500);
  expect(console.error).toHaveBeenCalledWith('[auth/send-email-hook] Transactional email send failed', {
    provider: 'sendgrid', action: 'recovery', stage: 'configuration', code: 'missing_configuration', missingConfiguration: ['SENDGRID_API_KEY'],
  });
  expect(sgMail.send).not.toHaveBeenCalled(); expect(global.fetch).not.toHaveBeenCalled();
});

it('identifies an invalid provider without logging its raw value', async () => {
  const sensitive = randomBytes(32).toString('hex');
  process.env.TRANSACTIONAL_EMAIL_PROVIDER = sensitive;
  expect((await POST(recoveryRequest())).status).toBe(500);
  expect(console.error).toHaveBeenCalledWith('[auth/send-email-hook] Transactional email send failed', {
    provider: 'invalid', action: 'recovery', stage: 'configuration', code: 'invalid_provider',
  });
  expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain(sensitive);
  expect(global.fetch).not.toHaveBeenCalled(); expect(sgMail.send).not.toHaveBeenCalled();
});

it('reports rejected provider credentials without echoing the response or tokens', async () => {
  const sensitive = randomBytes(32).toString('hex');
  (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 401, text: async () => JSON.stringify({ message: sensitive }) });
  expect((await POST(recoveryRequest())).status).toBe(500);
  expect(console.error).toHaveBeenCalledWith('[auth/send-email-hook] Transactional email send failed', {
    provider: 'zavu', action: 'recovery', stage: 'sender_verification', code: 'provider_auth_failed', httpStatus: 401,
  });
  expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain(sensitive);
  expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain(token);
  expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain(hash);
});
