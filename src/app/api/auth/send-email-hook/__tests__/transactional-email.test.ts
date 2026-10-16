import { createHmac, randomBytes } from 'node:crypto';
import { NextRequest } from 'next/server';
import { sendGridService } from '@/lib/services/sendgrid-service';
import { POST } from '../route';

jest.mock('@/lib/services/sendgrid-service', () => ({ sendGridService: { sendEmail: jest.fn() } }));
jest.mock('@/lib/i18n/email-locale', () => ({
  resolveEmailLocale: jest.fn().mockResolvedValue('en'), tryNormalizeEmailLocale: (locale: string) => locale,
}));
jest.mock('@/lib/i18n/team-invitation-context', () => ({ resolveTeamInvitationContext: () => null }));
jest.mock('@/lib/i18n/auth-email-template', () => ({
  buildSupabaseConfirmUrl: (params: any) => `https://auth.example.invalid/confirm?token=${params.tokenHash}`,
  generateAuthEmailContent: (params: any) => ({ subject: 'Authentication', text: params.confirmUrl || params.token, html: `<p>${params.confirmUrl || params.token}</p>` }),
}));

const originalEnv = process.env;
let signingKey: Buffer;
let token: string;
let tokenHash: string;

beforeEach(() => {
  jest.clearAllMocks();
  signingKey = randomBytes(32); token = randomBytes(6).toString('hex'); tokenHash = randomBytes(32).toString('hex');
  process.env = { NODE_ENV: 'test', SEND_EMAIL_HOOK_SECRET: `v1,whsec_${signingKey.toString('base64')}`, NEXT_PUBLIC_SUPABASE_URL: 'https://auth.example.invalid' };
  (sendGridService.sendEmail as jest.Mock).mockResolvedValue({ success: true, messageId: 'provider-message' });
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { process.env = originalEnv; jest.restoreAllMocks(); });

function request(overrides: any = {}, valid = true): NextRequest {
  const payload = {
    user: { id: 'user-1', email: 'user@example.invalid', user_metadata: { site_id: 'untrusted-site' } },
    email_data: { token, token_hash: tokenHash, email_action_type: 'magiclink', redirect_to: 'https://app.example.invalid/auth/callback' },
    ...overrides,
  };
  const body = JSON.stringify(payload); const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', valid ? signingKey : randomBytes(32)).update(`event-1.${timestamp}.${body}`).digest('base64');
  return new NextRequest('https://api.example.invalid/api/auth/send-email-hook', {
    method: 'POST', body,
    headers: { 'webhook-id': 'event-1', 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${signature}` },
  });
}

it('preserves the link email and delegates with a stable hashed key and shared deadline', async () => {
  expect((await POST(request())).status).toBe(200);
  expect((await POST(request())).status).toBe(200);
  const calls = (sendGridService.sendEmail as jest.Mock).mock.calls;
  expect(calls[0][0]).toMatchObject({ to: 'user@example.invalid', subject: 'Authentication', text: expect.stringContaining(tokenHash),
    categories: ['auth', 'supabase-auth-hook', 'magiclink'] });
  expect(calls[0][0].signal).toBeInstanceOf(AbortSignal);
  expect(calls[0][0].idempotencyKey).toBe(calls[1][0].idempotencyKey);
  expect(calls[0][0].idempotencyKey).not.toContain(token);
  expect(calls[0][0].idempotencyKey).not.toContain(tokenHash);
  expect(calls[0][0]).not.toHaveProperty('siteId'); expect(calls[0][0]).not.toHaveProperty('senderId');
  expect(JSON.stringify(calls[0][0].customArgs)).not.toContain(token);
  expect(JSON.stringify(calls[0][0].customArgs)).not.toContain(tokenHash);
});

it('preserves OTP emails without adding a confirmation link', async () => {
  await POST(request({ email_data: { token, email_action_type: 'reauthentication' } }));
  expect(sendGridService.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ text: token }));
});

it('sends both secure email-change messages with distinct keys and one deadline', async () => {
  const nextTokenHash = randomBytes(32).toString('hex');
  await POST(request({ user: { email: 'old@example.invalid', new_email: 'new@example.invalid' },
    email_data: { token, token_hash: tokenHash, token_hash_new: nextTokenHash, email_action_type: 'email_change' } }));
  const calls = (sendGridService.sendEmail as jest.Mock).mock.calls;
  expect(calls).toHaveLength(2);
  expect(calls[0][0].to).toBe('old@example.invalid'); expect(calls[1][0].to).toBe('new@example.invalid');
  expect(calls[0][0].idempotencyKey).not.toBe(calls[1][0].idempotencyKey);
  expect(calls[0][0].signal).toBe(calls[1][0].signal);
});

it('rejects invalid signatures without sending', async () => {
  expect((await POST(request({}, false))).status).toBe(401);
  expect(sendGridService.sendEmail).not.toHaveBeenCalled();
});

it('returns the Supabase error contract without exposing provider errors or auth values', async () => {
  (sendGridService.sendEmail as jest.Mock).mockResolvedValue({ success: false, error: `${token} ${tokenHash}` });
  const response = await POST(request());
  expect(response.status).toBe(500);
  const body = await response.json();
  expect(body).toEqual({ error: { http_code: 500, message: 'Failed to send authentication email' } });
  const output = JSON.stringify({ body, logs: (console.error as jest.Mock).mock.calls });
  expect(output).not.toContain(token); expect(output).not.toContain(tokenHash);
});
