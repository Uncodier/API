import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { NextRequest } from 'next/server';

const validateApiKey = jest.fn();

jest.mock('@/lib/services/api-keys/ApiKeyService', () => ({
  ApiKeyService: { validateApiKey },
}));
jest.mock('@/lib/status/telemetry', () => ({
  recordTelemetry: jest.fn(() => Promise.resolve()),
}));

import { apiKeyAuth, requiredApiKeyScope } from '../apiKeyAuth';

describe('apiKeyAuth', () => {
  beforeEach(() => {
    validateApiKey.mockReset();
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
    expect(requiredApiKeyScope('/api/public/posts', 'GET')).toBeNull();
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
});
