import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { NextRequest } from 'next/server';
import { getLatestTelemetry, recordTelemetry, type TelemetryRecord } from '@/lib/status/telemetry';
import { integrationsHandler } from '@/lib/status/handlers/integrations';
import { notificationsHandler } from '@/lib/status/handlers/notifications';
import { apiAuthHandler } from '@/lib/status/handlers/auth';
import type { SystemHealthHandler } from '@/lib/status/types';
import { claimProviderWebhookEvent, finishProviderWebhookEvent } from '@/lib/services/provider-webhook-claims';
import { headers } from 'next/headers';

jest.mock('@/lib/status/telemetry', () => ({
  getLatestTelemetry: jest.fn(),
  recordTelemetry: jest.fn(),
}));
jest.mock('@/lib/services/provider-webhook-claims', () => ({
  claimProviderWebhookEvent: jest.fn(),
  finishProviderWebhookEvent: jest.fn(),
}));
jest.mock('@/lib/database/supabase-server', () => ({ supabaseAdmin: {} }));
jest.mock('next/headers', () => ({ headers: jest.fn() }));
const mockConstructEvent = jest.fn<(...args: unknown[]) => any>();
jest.mock('stripe', () => jest.fn(() => ({ webhooks: { constructEvent: mockConstructEvent } })));

const latest = jest.mocked(getLatestTelemetry);
const record = jest.mocked(recordTelemetry);
const originalEnv = process.env;
const now = new Date('2026-09-20T12:00:00.000Z').getTime();
const credential = () => randomBytes(32).toString('hex');

function receipt(status: TelemetryRecord['status'] = 'up', ageMs = 0): TelemetryRecord {
  return {
    status,
    message: `Observed execution: ${status}`,
    latency_ms: 0,
    created_at: new Date(now - ageMs).toISOString(),
  };
}

beforeEach(() => {
  jest.resetAllMocks();
  process.env = { NODE_ENV: 'test' };
  jest.spyOn(Date, 'now').mockReturnValue(now);
  jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden in offline tests'));
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  latest.mockResolvedValue(null);
  record.mockResolvedValue(undefined);
});

afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  process.env = originalEnv;
  jest.restoreAllMocks();
});

const passiveHandlers: Array<[string, SystemHealthHandler, string]> = [
  ['authentication', apiAuthHandler, 'api_auth'],
];

describe.each(passiveHandlers)('%s passive execution evidence', (_label, handler, key) => {
  it('does not infer health from configuration or registered routes', async () => {
    process.env.SERVICE_API_KEY = credential();
    const result = await handler.runCheck();
    expect(result).toMatchObject({ status: 'skipped', checks: { verification: 'unverified', telemetryFound: false } });
    expect(result.checks).not.toHaveProperty('routesRegistered');
    expect(latest).toHaveBeenCalledWith(key, 0.25);
    expect(JSON.stringify(result)).not.toContain(process.env.SERVICE_API_KEY);
    expect(record).not.toHaveBeenCalled();
  });

  it.each(['up', 'degraded', 'down'] as const)('preserves fresh observed %s, including zero latency', async (status) => {
    latest.mockResolvedValue(receipt(status, 10 * 60 * 1000));
    await expect(handler.runCheck()).resolves.toMatchObject({
      status,
      latencyMs: 0,
      checks: { verification: 'observed', telemetryFresh: true, freshnessWindowMinutes: 15 },
    });
  });

  it.each(['up', 'down'] as const)('does not trust stale %s evidence', async (status) => {
    latest.mockResolvedValue(receipt(status, 15 * 60 * 1000 + 1));
    await expect(handler.runCheck()).resolves.toMatchObject({
      status: 'skipped', checks: { verification: 'unverified', telemetryFound: true, telemetryFresh: false },
    });
  });

  it.each(['invalid-date', new Date(now + 1).toISOString()])('does not trust malformed/future timestamp %s', async (created_at) => {
    latest.mockResolvedValue({ ...receipt(), created_at });
    await expect(handler.runCheck()).resolves.toMatchObject({
      status: 'skipped', checks: { verification: 'unverified', telemetryFresh: false },
    });
  });

  it('does not treat a skipped telemetry record as observed execution', async () => {
    latest.mockResolvedValue(receipt('skipped'));
    await expect(handler.runCheck()).resolves.toMatchObject({ status: 'skipped', checks: { verification: 'unverified' } });
  });

  it('accepts evidence at exactly the 15 minute freshness boundary', async () => {
    latest.mockResolvedValue(receipt('up', 15 * 60 * 1000));
    await expect(handler.runCheck()).resolves.toMatchObject({ status: 'up', checks: { verification: 'observed' } });
  });
});

describe('provider-specific integration evidence', () => {
  function configureAll() {
    process.env.STRIPE_WEBHOOK_SECRET = credential();
    process.env.WHATSAPP_APP_SECRET = credential();
    process.env.AGENTMAIL_API_KEY = credential();
  }

  it('skips unconfigured providers without retrieving telemetry', async () => {
    await expect(integrationsHandler.runCheck()).resolves.toMatchObject({
      status: 'skipped', checks: { verification: 'unverified', configuredCount: 0, stripe: { status: 'skipped' } },
    });
    expect(latest).not.toHaveBeenCalled();
  });

  it('skips every configured provider when no receipts exist', async () => {
    configureAll();
    const result = await integrationsHandler.runCheck();
    expect(result).toMatchObject({
      status: 'skipped',
      checks: {
        verification: 'unverified', observedCount: 0, configuredCount: 3, observedFailure: false,
        stripe: { status: 'skipped', verification: 'unverified' },
        whatsapp: { status: 'skipped', verification: 'unverified' },
        agentmail: { status: 'skipped', verification: 'unverified' },
      },
    });
    for (const name of ['STRIPE_WEBHOOK_SECRET', 'WHATSAPP_APP_SECRET', 'AGENTMAIL_API_KEY']) {
      expect(JSON.stringify(result)).not.toContain(process.env[name]);
    }
  });

  it('recognizes the message-received AgentMail webhook secret without generic credentials', async () => {
    process.env.AGENTMAIL_WEBHOOK_SECRET_MESSAGE_RECEIVED = credential();
    latest.mockResolvedValue(receipt());
    const result = await integrationsHandler.runCheck();
    expect(result).toMatchObject({
      status: 'up', checks: { configuredCount: 1, observedFailure: false, agentmail: { configured: true, verification: 'observed' } },
    });
    expect(latest).toHaveBeenCalledWith('integrations_agentmail', 0.25);
    expect(JSON.stringify(result)).not.toContain(process.env.AGENTMAIL_WEBHOOK_SECRET_MESSAGE_RECEIVED);
  });

  it('ignores legacy generic success rather than masking unobserved providers', async () => {
    configureAll();
    latest.mockImplementation(async (key) => key === 'integrations' ? receipt('up') : null);
    await expect(integrationsHandler.runCheck()).resolves.toMatchObject({ status: 'skipped', checks: { verification: 'unverified' } });
    expect(latest.mock.calls.map(([key]) => key).sort()).toEqual([
      'integrations_agentmail', 'integrations_stripe', 'integrations_whatsapp',
    ]);
    for (const [, window] of latest.mock.calls) expect(window).toBe(0.25);
  });

  it.each(['integrations_stripe', 'integrations_whatsapp', 'integrations_agentmail'])('a lone %s success is only partial evidence', async (observedKey) => {
    configureAll();
    latest.mockImplementation(async (key) => key === observedKey ? receipt() : null);
    await expect(integrationsHandler.runCheck()).resolves.toMatchObject({
      status: 'degraded', checks: { verification: 'partial', observedCount: 1, configuredCount: 3, observedFailure: false },
    });
  });

  it('does not let a recent Stripe success mask stale WhatsApp evidence', async () => {
    process.env.STRIPE_SECRET_KEY = credential();
    process.env.WHATSAPP_APP_SECRET = credential();
    latest.mockImplementation(async (key) => key === 'integrations_stripe' ? receipt() : receipt('up', 20 * 60 * 1000));
    await expect(integrationsHandler.runCheck()).resolves.toMatchObject({
      status: 'degraded',
      checks: {
        verification: 'partial',
        stripe: { status: 'up', verification: 'observed' },
        whatsapp: { status: 'skipped', verification: 'unverified', telemetryFresh: false },
      },
    });
  });

  it('skips all-stale provider receipts even when they previously failed', async () => {
    configureAll();
    latest.mockResolvedValue(receipt('down', 20 * 60 * 1000));
    await expect(integrationsHandler.runCheck()).resolves.toMatchObject({ status: 'skipped', checks: { verification: 'unverified', observedFailure: false } });
  });

  it('does not count skipped provider receipts as observed', async () => {
    configureAll();
    latest.mockResolvedValue(receipt('skipped'));
    await expect(integrationsHandler.runCheck()).resolves.toMatchObject({ status: 'skipped', checks: { verification: 'unverified' } });
  });

  it.each(['integrations_stripe', 'integrations_whatsapp', 'integrations_agentmail'])('preserves a known %s failure despite unrelated successes', async (failedKey) => {
    configureAll();
    latest.mockImplementation(async (key) => receipt(key === failedKey ? 'down' : 'up'));
    await expect(integrationsHandler.runCheck()).resolves.toMatchObject({ status: 'down', checks: { verification: 'observed', observedFailure: true } });
  });

  it('known failure takes precedence even with missing provider evidence', async () => {
    configureAll();
    latest.mockImplementation(async (key) => key === 'integrations_agentmail' ? receipt('down') : null);
    await expect(integrationsHandler.runCheck()).resolves.toMatchObject({ status: 'down', checks: { verification: 'partial', observedFailure: true } });
  });

  it('preserves observed degraded execution with complete provider evidence', async () => {
    configureAll();
    latest.mockImplementation(async (key) => receipt(key === 'integrations_agentmail' ? 'degraded' : 'up'));
    await expect(integrationsHandler.runCheck()).resolves.toMatchObject({ status: 'degraded', checks: { verification: 'observed', observedFailure: true } });
  });

  it('reports up only when every configured provider has fresh successful execution evidence', async () => {
    configureAll();
    latest.mockResolvedValue(receipt());
    await expect(integrationsHandler.runCheck()).resolves.toMatchObject({ status: 'up', checks: { verification: 'observed', observedCount: 3 } });
    expect(record).not.toHaveBeenCalled();
  });
});

describe('webhook telemetry lifetime and isolation', () => {
  let whatsappPost: typeof import('@/app/api/integrations/whatsapp/webhook/post-handler').handleMetaWebhookPost;
  let stripePost: typeof import('@/app/api/integrations/stripe/webhook/route').POST;

  beforeAll(async () => {
    ({ handleMetaWebhookPost: whatsappPost } = await import('@/app/api/integrations/whatsapp/webhook/post-handler'));
    ({ POST: stripePost } = await import('@/app/api/integrations/stripe/webhook/route'));
  });

  beforeEach(() => {
    process.env.STRIPE_WEBHOOK_SECRET = credential();
    process.env.WHATSAPP_APP_SECRET = credential();
    jest.mocked(claimProviderWebhookEvent).mockResolvedValue({
      state: 'claimed', token: credential(), expiresAt: new Date(now + 60_000).toISOString(),
    });
    jest.mocked(finishProviderWebhookEvent).mockResolvedValue(true);
    jest.mocked(headers).mockResolvedValue(new Headers({ 'stripe-signature': credential() }) as Awaited<ReturnType<typeof headers>>);
    mockConstructEvent.mockReturnValue({ id: randomUUID(), type: 'test.event', data: { object: {} } });
  });

  function whatsappRequest(): NextRequest {
    const body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ field: 'messages', value: {
        metadata: { phone_number_id: randomUUID() },
        messages: [{ id: randomUUID(), from: randomUUID(), type: 'text' }],
      } }] }],
    });
    const url = new URL('https://example.test/api/integrations/whatsapp/webhook');
    url.searchParams.set('site_id', randomUUID());
    const signature = createHmac('sha256', process.env.WHATSAPP_APP_SECRET!).update(body).digest('hex');
    return new NextRequest(url, { method: 'POST', body, headers: { 'x-hub-signature-256': `sha256=${signature}` } });
  }

  it.each(['stripe', 'whatsapp'] as const)('awaits %s success emission before returning without changing processing', async (provider) => {
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const emitted = new Promise<void>((resolve) => { started = resolve; });
    record.mockImplementation(() => { started(); return pending; });
    const processMessage = jest.fn<(...args: any[]) => Promise<{ success: boolean }>>().mockResolvedValue({ success: true });
    let responded = false;
    const response = (provider === 'stripe'
      ? stripePost(new NextRequest('https://example.test/api/integrations/stripe/webhook', { method: 'POST', body: '{}' }))
      : whatsappPost(whatsappRequest(), processMessage)).then((result) => { responded = true; return result; });
    await emitted;
    expect(responded).toBe(false);
    expect(record).toHaveBeenCalledWith(`integrations_${provider}`, 'up', expect.any(String));
    expect(jest.mocked(finishProviderWebhookEvent)).toHaveBeenCalledWith(
      provider === 'stripe' ? 'stripe' : 'meta-whatsapp', expect.any(String), expect.any(String), 'completed',
    );
    release();
    expect((await response).status).toBe(200);
    if (provider === 'whatsapp') expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it('records WhatsApp processing failure only for WhatsApp and preserves its failed claim', async () => {
    const processMessage = jest.fn<(...args: any[]) => Promise<null>>().mockResolvedValue(null);
    const response = await whatsappPost(whatsappRequest(), processMessage);
    expect(response.status).toBe(500);
    expect(record).toHaveBeenCalledWith('integrations_whatsapp', 'down', 'WhatsApp Webhook error');
    expect(finishProviderWebhookEvent).toHaveBeenCalledWith('meta-whatsapp', expect.any(String), expect.any(String), 'failed', expect.any(String));
  });

  it.each(['stripe', 'whatsapp'] as const)('awaits %s failure emission before returning', async (provider) => {
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const emitted = new Promise<void>((resolve) => { started = resolve; });
    record.mockImplementation(() => { started(); return pending; });
    jest.mocked(finishProviderWebhookEvent).mockResolvedValueOnce(false);
    const processMessage = jest.fn<(...args: any[]) => Promise<null>>().mockResolvedValue(null);
    let responded = false;
    const response = (provider === 'stripe'
      ? stripePost(new NextRequest('https://example.test/api/integrations/stripe/webhook', { method: 'POST', body: '{}' }))
      : whatsappPost(whatsappRequest(), processMessage)).then((result) => { responded = true; return result; });
    await emitted;
    expect(responded).toBe(false);
    expect(record).toHaveBeenCalledWith(`integrations_${provider}`, 'down', expect.any(String));
    release();
    expect((await response).status).toBe(500);
  });

  it.each(['stripe', 'whatsapp'] as const)('does not turn a telemetry write failure into failed %s processing', async (provider) => {
    record.mockRejectedValue(new Error('Telemetry unavailable'));
    const processMessage = jest.fn<(...args: any[]) => Promise<{ success: boolean }>>().mockResolvedValue({ success: true });
    const response = await (provider === 'stripe'
      ? stripePost(new NextRequest('https://example.test/api/integrations/stripe/webhook', { method: 'POST', body: '{}' }))
      : whatsappPost(whatsappRequest(), processMessage));
    expect(response.status).toBe(200);
    expect(finishProviderWebhookEvent).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(`integrations_${provider}`, 'up', expect.any(String));
  });

  it('records Stripe processing failure only for Stripe and preserves its failed claim', async () => {
    jest.mocked(finishProviderWebhookEvent).mockResolvedValueOnce(false);
    const response = await stripePost(new NextRequest('https://example.test/api/integrations/stripe/webhook', { method: 'POST', body: '{}' }));
    expect(response.status).toBe(500);
    expect(record).toHaveBeenCalledWith('integrations_stripe', 'down', 'Error processing Stripe webhook');
    expect(finishProviderWebhookEvent).toHaveBeenCalledWith('stripe', expect.any(String), expect.any(String), 'failed', expect.any(String));
  });

  it('preserves Stripe signature rejection without falsely reporting a provider outage', async () => {
    mockConstructEvent.mockImplementation(() => { throw new Error('Signature verification failed'); });
    const response = await stripePost(new NextRequest('https://example.test/api/integrations/stripe/webhook', { method: 'POST', body: '{}' }));
    expect(response.status).toBe(400);
    expect(record).not.toHaveBeenCalled();
    expect(claimProviderWebhookEvent).not.toHaveBeenCalled();
  });

  it('preserves WhatsApp signature rejection without processing or success telemetry', async () => {
    const processMessage = jest.fn<(...args: any[]) => Promise<null>>();
    const request = new NextRequest('https://example.test/api/integrations/whatsapp/webhook', { method: 'POST', body: '{}' });
    expect((await whatsappPost(request, processMessage)).status).toBe(401);
    expect(processMessage).not.toHaveBeenCalled();
    expect(claimProviderWebhookEvent).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
});