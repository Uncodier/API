import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { NextRequest } from 'next/server';

const hasAuthenticatedPrincipal = jest.fn();
const canAccessSite = jest.fn();
const issuePublicImageSignature = jest.fn();

jest.mock('@/lib/security/request-rate-limit', () => ({
  hasAuthenticatedPrincipal,
}));
jest.mock('@/lib/security/site-access', () => ({ canAccessSite }));
jest.mock('@/lib/security/public-image-signature', () => ({
  issuePublicImageSignature,
}));

import { POST } from '../route';

const siteId = '11111111-1111-4111-8111-111111111111';

function request(body: object) {
  return new NextRequest('https://backend.makinari.com/api/public/image/sign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('public image signing route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    hasAuthenticatedPrincipal.mockReturnValue(true as never);
    canAccessSite.mockResolvedValue(true as never);
    issuePublicImageSignature.mockReturnValue({
      expires: 1_800_000_300,
      signature: 'a'.repeat(64),
    } as never);
  });

  it('returns a site-bound signed generation URL', async () => {
    const response = await POST(request({
      site_id: siteId,
      prompt: 'A branded product photo',
      width: 800,
      height: 600,
    }));
    const body = await response.json();
    const url = new URL(body.url);

    expect(response.status).toBe(200);
    expect(canAccessSite).toHaveBeenCalledWith(expect.any(NextRequest), siteId);
    expect(issuePublicImageSignature).toHaveBeenCalledWith(
      {
        siteId,
        prompt: 'A branded product photo',
        width: 800,
        height: 600,
      },
      600,
    );
    expect(url.pathname).toBe(
      '/api/public/image/prompt/A%20branded%20product%20photo',
    );
    expect(url.searchParams.get('site_id')).toBe(siteId);
    expect(url.searchParams.get('signature')).toBe('a'.repeat(64));
  });

  it('rejects unauthenticated signing requests', async () => {
    hasAuthenticatedPrincipal.mockReturnValue(false as never);

    const response = await POST(request({
      site_id: siteId,
      prompt: 'A branded product photo',
    }));

    expect(response.status).toBe(401);
    expect(canAccessSite).not.toHaveBeenCalled();
    expect(issuePublicImageSignature).not.toHaveBeenCalled();
  });
});
