import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { NextRequest } from 'next/server';
import { randomBytes } from 'node:crypto';

const validateApiKey = jest.fn();
const recordTelemetry = jest.fn<(...args: unknown[]) => Promise<void>>();
const enforceRequestRateLimit = jest.fn(async () => null);
const originalServiceCredential = process.env.SERVICE_API_KEY;

jest.unstable_mockModule('@/lib/services/api-keys/ApiKeyService', () => ({
  ApiKeyService: { validateApiKey },
}));
jest.unstable_mockModule('@/lib/status/telemetry', () => ({
  recordTelemetry,
}));
jest.unstable_mockModule('@/lib/security/request-rate-limit', () => ({
  enforceRequestRateLimit,
}));

// The repository's Jest runner uses native ESM; import after registering mocks
// so these unit regressions cannot contact database/telemetry/admission storage.
let apiKeyAuth: typeof import('../apiKeyAuth').apiKeyAuth;
let requiredApiKeyScope: typeof import('../apiKeyAuth').requiredApiKeyScope;
beforeAll(async () => {
  ({ apiKeyAuth, requiredApiKeyScope } = await import('../apiKeyAuth'));
});

describe('apiKeyAuth', () => {
  beforeEach(() => {
    validateApiKey.mockReset();
    recordTelemetry.mockReset().mockResolvedValue(undefined);
    enforceRequestRateLimit.mockClear();
    delete process.env.SERVICE_API_KEY;
  });

  afterEach(() => {
    if (originalServiceCredential === undefined) delete process.env.SERVICE_API_KEY;
    else process.env.SERVICE_API_KEY = originalServiceCredential;
    jest.restoreAllMocks();
  });

  it('does not treat a browser Origin as authentication', async () => {
    const response = await apiKeyAuth(new NextRequest(
      'https://api.makinari.com/api/private',
      { headers: { origin: 'https://app.makinari.com' } },
    ));

    expect(response.status).toBe(401);
    expect(validateApiKey).not.toHaveBeenCalled();
  });

  it('validates a supplied browser API key', async () => {
    (validateApiKey as any).mockResolvedValue({
      isValid: true,
      keyData: {
        id: 'key-id',
        name: 'Browser key',
        user_id: 'user-id',
        site_id: null,
        scopes: ['read'],
      },
    });
    const response = await apiKeyAuth(new NextRequest(
      'https://api.makinari.com/api/private',
      {
        headers: {
          origin: 'https://app.makinari.com',
          'x-api-key': 'key_secret',
        },
      },
    ));

    expect(response.status).toBe(200);
    expect(validateApiKey).toHaveBeenCalledWith('key_secret');
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('derives billable scopes from the server-side route', async () => {
    expect(requiredApiKeyScope('/api/ai/image', 'POST')).toBe('ai:generate');
    expect(requiredApiKeyScope('/api/public/video/prompt/demo', 'GET'))
      .toBe('ai:generate');
    expect(requiredApiKeyScope('/api/public/image/sign', 'POST'))
      .toBe('ai:generate');
    expect(requiredApiKeyScope(
      '/api/integrations/outstand/conversations',
      'GET',
    )).toBe('read');
    expect(requiredApiKeyScope(
      '/api/integrations/outstand/conversations/conversation-1/messages',
      'POST',
    )).toBe('write');
    expect(requiredApiKeyScope(
      '/api/integrations/outstand/conversations/conversation-1/messages/message-1',
      'DELETE',
    )).toBe('write');
    expect(requiredApiKeyScope(
      '/api/agents/tools/sendChannelMessage',
      'POST',
    )).toBe('write');
    expect(requiredApiKeyScope('/api/public/posts', 'GET')).toBeNull();
    expect(requiredApiKeyScope('/api/agents/sales/dueInvoices', 'POST')).toBe('write');
  });

  it('requires write scope on the authenticated invoice reminder action', async () => {
    (validateApiKey as any).mockResolvedValue({ isValid: true, keyData: {
      id: 'invoice-test-key', name: 'Read only', site_id: '00000000-0000-4000-8000-000000000001', scopes: ['read'],
    } });
    const response = await apiKeyAuth(new NextRequest('https://api.example.com/api/agents/sales/dueInvoices', {
      method: 'POST', headers: { 'x-api-key': randomBytes(32).toString('hex') },
    }));
    expect(response.status).toBe(403);
  });

  it('rejects a read-only key on a generation route', async () => {
    (validateApiKey as any).mockResolvedValue({
      isValid: true,
      keyData: {
        id: 'key-id',
        name: 'Read-only key',
        user_id: 'user-id',
        site_id: null,
        scopes: ['read'],
      },
    });

    const response = await apiKeyAuth(new NextRequest(
      'https://api.makinari.com/api/ai/image',
      { method: 'POST', headers: { 'x-api-key': 'key_secret' } },
    ));

    expect(response.status).toBe(403);
  });

  it('rejects a read-only key that attempts to send an Outstand DM', async () => {
    (validateApiKey as any).mockResolvedValue({
      isValid: true,
      keyData: {
        id: 'key-id',
        name: 'Read-only key',
        user_id: 'user-id',
        site_id: '00000000-0000-4000-8000-000000000001',
        scopes: ['read'],
      },
    });

    const response = await apiKeyAuth(new NextRequest(
      'https://api.makinari.com/api/integrations/outstand/conversations/conversation-1/messages',
      { method: 'POST', headers: { 'x-api-key': 'key_secret' } },
    ));

    expect(response.status).toBe(403);
  });

  it('does not forward caller-supplied internal identity headers', async () => {
    (validateApiKey as any).mockResolvedValue({
      isValid: true,
      keyData: {
        id: 'key-id',
        name: 'Scoped key',
        user_id: 'real-user',
        site_id: null,
        scopes: ['read'],
      },
    });
    const response = await apiKeyAuth(new NextRequest(
      'https://api.makinari.com/api/private',
      {
        headers: {
          'x-api-key': 'key_secret',
          'x-auth-user-id': 'spoofed-user',
          'x-auth-validated': 'true',
          'x-api-key-data': '{"id":"spoofed-key"}',
          'x-required-scope': '*',
        },
      },
    ));

    expect(response.headers.get('x-middleware-request-x-auth-user-id')).toBeNull();
    expect(response.headers.get('x-middleware-request-x-auth-validated')).toBeNull();
    expect(response.headers.get('x-middleware-request-x-required-scope')).toBeNull();
    expect(response.headers.get('x-middleware-request-x-api-key-data'))
      .toContain('"id":"key-id"');
  });

  describe('telemetry request lifecycle', () => {
    function deferred() {
      let resolve!: () => void;
      const promise = new Promise<void>(done => { resolve = done; });
      return { promise, resolve };
    }

    function authenticatedRequest() {
      return new NextRequest('https://api.example.test/api/private', {
        headers: { 'x-api-key': randomBytes(32).toString('hex') },
      });
    }

    function validKey() {
      (validateApiKey as any).mockResolvedValue({
        isValid: true, keyData: { id: 'key-id', name: 'Scoped key', scopes: ['read'] },
      });
    }

    it.each<[string, number, string, string]>([
      ['service', 200, 'up', 'Service API Key used'],
      ['valid', 200, 'up', 'Valid DB API key'],
      ['invalid', 401, 'up', 'Invalid API key rejected'],
      ['error', 500, 'down', 'API key authentication failed'],
    ])('registers %s telemetry without blocking the auth response', async (scenario, status, health, message) => {
      const pending = deferred();
      recordTelemetry.mockReturnValueOnce(pending.promise);
      jest.spyOn(console, 'error').mockImplementation(() => {});
      const request = authenticatedRequest();
      if (scenario === 'service') process.env.SERVICE_API_KEY = request.headers.get('x-api-key')!;
      else if (scenario === 'valid') validKey();
      else if (scenario === 'invalid') (validateApiKey as any).mockResolvedValue({ isValid: false, keyData: null });
      else (validateApiKey as any).mockRejectedValue(new Error(randomBytes(32).toString('hex')));
      const waitUntil = jest.fn<(promise: Promise<unknown>) => void>();
      try {
        const response = await apiKeyAuth(request, { waitUntil });
        expect(response.status).toBe(status);
        expect(waitUntil).toHaveBeenCalledTimes(1);
        expect(recordTelemetry).toHaveBeenCalledWith('api_auth', health, message, expect.any(Number));
        if (scenario === 'service') expect(validateApiKey).not.toHaveBeenCalled();
      } finally {
        pending.resolve();
        await waitUntil.mock.calls[0]?.[0];
      }
    });

    it.each([false, true])('awaits telemetry when no lifecycle can retain it (registration throws: %s)', async registrationThrows => {
      validKey();
      const pending = deferred();
      const started = deferred();
      recordTelemetry.mockImplementationOnce(() => { started.resolve(); return pending.promise; });
      jest.spyOn(console, 'warn').mockImplementation(() => {});
      const waitUntil = jest.fn<(promise: Promise<unknown>) => void>(() => { throw new Error('No request lifecycle'); });
      let settled = false;
      const auth = apiKeyAuth(authenticatedRequest(), registrationThrows ? { waitUntil } : undefined)
        .then(response => { settled = true; return response; });
      try {
        await started.promise;
        await Promise.resolve();
        expect(settled).toBe(false);
      } finally {
        pending.resolve();
      }
      expect((await auth).status).toBe(200);
      expect(waitUntil).toHaveBeenCalledTimes(registrationThrows ? 1 : 0);
    });

    it.each([false, true])('contains telemetry rejection without changing auth or leaking secrets (lifecycle: %s)', async lifecycle => {
      validKey();
      const secret = randomBytes(32).toString('hex');
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      recordTelemetry.mockRejectedValueOnce(new Error(secret));
      const waitUntil = jest.fn<(promise: Promise<unknown>) => void>();
      expect((await apiKeyAuth(authenticatedRequest(), lifecycle ? { waitUntil } : undefined)).status).toBe(200);
      if (lifecycle) await expect(waitUntil.mock.calls[0][0]).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith('[API Key Auth] Telemetry failed');
      expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
    });

    it('contains a synchronous telemetry exception after lifecycle registration', async () => {
      validKey();
      jest.spyOn(console, 'warn').mockImplementation(() => {});
      recordTelemetry.mockImplementationOnce(() => { throw new Error('Telemetry failed'); });
      const waitUntil = jest.fn<(promise: Promise<unknown>) => void>();
      expect((await apiKeyAuth(authenticatedRequest(), { waitUntil })).status).toBe(200);
      await expect(waitUntil.mock.calls[0][0]).resolves.toBeUndefined();
    });

    it('does not leak authentication exceptions into telemetry or logs', async () => {
      const secret = randomBytes(32).toString('hex');
      (validateApiKey as any).mockRejectedValueOnce(new Error(secret));
      const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
      expect((await apiKeyAuth(authenticatedRequest())).status).toBe(500);
      expect(JSON.stringify([errorLog.mock.calls, recordTelemetry.mock.calls])).not.toContain(secret);
    });
  });
});
