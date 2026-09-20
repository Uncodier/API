import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { NextRequest, NextResponse } from 'next/server';

const getPersistedHealthResponse: any = jest.fn();
const runHealthHandlerResponse: any = jest.fn();
const enforceRequestRateLimit: any = jest.fn();
const isInternalServiceRequest: any = jest.fn();
const acquireLock: any = jest.fn();
const releaseLock: any = jest.fn();

jest.mock('@/lib/status/health-route-helper', () => ({
  getPersistedHealthResponse,
  runHealthHandlerResponse,
}));
jest.mock('@/lib/security/request-rate-limit', () => ({
  enforceRequestRateLimit,
  getAuthenticatedRateIdentity: jest.fn(() => 'api-key:service-key'),
  isInternalServiceRequest,
}));
jest.mock('@/lib/security/upstash-rest', () => ({
  acquireLock,
  releaseLock,
}));

import { GET } from '../route';

const context = {
  params: Promise.resolve({ systemKey: 'database' }),
};

describe('system status route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    enforceRequestRateLimit.mockResolvedValue(null);
    acquireLock.mockResolvedValue({
      state: 'acquired',
      token: 'lock-token',
    });
    releaseLock.mockResolvedValue(undefined);
    getPersistedHealthResponse.mockResolvedValue(
      NextResponse.json({ status: 'up' }),
    );
    runHealthHandlerResponse.mockResolvedValue(
      NextResponse.json({ status: 'up' }),
    );
  });

  it('serves persisted status without running a live probe', async () => {
    const response = await GET(
      new NextRequest('https://api.example/api/status/systems/database'),
      context,
    );

    expect(response.status).toBe(200);
    expect(getPersistedHealthResponse).toHaveBeenCalledWith('database');
    expect(runHealthHandlerResponse).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated live probes', async () => {
    isInternalServiceRequest.mockReturnValue(false);

    const response = await GET(
      new NextRequest('https://api.example/api/status/systems/database?live=1'),
      context,
    );

    expect(response.status).toBe(403);
    expect(runHealthHandlerResponse).not.toHaveBeenCalled();
  });

  it('single-flights authorized live probes', async () => {
    isInternalServiceRequest.mockReturnValue(true);

    const response = await GET(
      new NextRequest('https://api.example/api/status/systems/database?live=1'),
      context,
    );

    expect(response.status).toBe(200);
    expect(acquireLock).toHaveBeenCalledWith('lock:status-live:database', 60);
    expect(runHealthHandlerResponse).toHaveBeenCalledWith(
      'database',
      { live: true },
    );
    expect(releaseLock).toHaveBeenCalledWith(
      'lock:status-live:database',
      'lock-token',
    );
  });

  it('returns 503 when live-probe coordination is unavailable', async () => {
    isInternalServiceRequest.mockReturnValue(true);
    acquireLock.mockResolvedValue({ state: 'unavailable' });

    const response = await GET(
      new NextRequest('https://api.example/api/status/systems/database?live=1'),
      context,
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('5');
    expect(runHealthHandlerResponse).not.toHaveBeenCalled();
  });
});
