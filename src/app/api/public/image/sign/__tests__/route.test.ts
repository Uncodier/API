import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { NextRequest } from 'next/server';

const hasAuthenticatedPrincipal = jest.fn();
const canAccessSite = jest.fn();
const issuePublicImageSignature = jest.fn();

jest.unstable_mockModule('@/lib/security/request-rate-limit', () => ({
  hasAuthenticatedPrincipal,
}));
jest.unstable_mockModule('@/lib/security/site-access', () => ({ canAccessSite }));
jest.unstable_mockModule('@/lib/security/public-image-signature', () => ({
  issuePublicImageSignature,
}));

const { POST } = await import('../route');

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

  it.each([[3_000, 200], [3_001, 400]])('applies the image prompt length limit when signing (%i characters)', async (length, status) => {
    const prompt = 'a'.repeat(length);
    const response = await POST(request({ site_id: siteId, prompt }));

    expect(response.status).toBe(status);
    if (status === 200) {
      expect(issuePublicImageSignature).toHaveBeenCalledWith(expect.objectContaining({ prompt }), 600);
    } else {
      expect(await response.json()).toEqual({ error: 'prompt must contain between 1 and 3000 characters' });
      expect(issuePublicImageSignature).not.toHaveBeenCalled();
    }
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
