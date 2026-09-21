import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { NextRequest, NextResponse } from 'next/server';

const start = jest.fn();
const getPromptHash = jest.fn(() => 'image-hash');
const downloadFromCache = jest.fn();
const resolveSiteFromRequirementUrl = jest.fn();
const hasAuthenticatedPrincipal = jest.fn();
const enforceRequestRateLimit = jest.fn();
const canAccessSite = jest.fn();
const acquireLock = jest.fn();
const releaseLock = jest.fn();

jest.mock('workflow/api', () => ({ start }));
jest.mock('@/lib/services/image/promptImageCache', () => ({
  getPromptHash,
  downloadFromCache,
}));
jest.mock('@/lib/services/image/resolveSiteFromRequirementUrl', () => ({
  resolveSiteFromRequirementUrl,
}));
jest.mock('@/lib/security/request-rate-limit', () => ({
  hasAuthenticatedPrincipal,
  enforceRequestRateLimit,
}));
jest.mock('@/lib/security/site-access', () => ({ canAccessSite }));
jest.mock('@/lib/security/upstash-rest', () => ({
  acquireLock,
  releaseLock,
}));

import { GET } from '../[...prompt]/route';

const context = {
  params: Promise.resolve({ prompt: ['a cat'] }),
};

function request(query = '') {
  return new NextRequest(
    `https://backend.makinari.com/api/public/image/prompt/a%20cat${query}`,
    { headers: { referer: 'https://preview.example.com/page' } },
  );
}

describe('public prompt image route caching', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resolveSiteFromRequirementUrl.mockResolvedValue('site-id' as never);
    hasAuthenticatedPrincipal.mockReturnValue(false as never);
    canAccessSite.mockResolvedValue(true as never);
    acquireLock.mockResolvedValue({
      state: 'acquired',
      token: 'lock-token',
    } as never);
    releaseLock.mockResolvedValue({ state: 'released' } as never);
    enforceRequestRateLimit.mockResolvedValue(null as never);
  });

  it('serves a cached image for a resolved site before authentication or limiting', async () => {
    downloadFromCache.mockResolvedValue({
      buffer: Buffer.from('cached-image'),
      mimeType: 'image/png',
    } as never);

    const response = await GET(request(), context);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control')).toBe(
      'public, max-age=31536000, s-maxage=31536000, immutable',
    );
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('cached-image');
    expect(resolveSiteFromRequirementUrl).toHaveBeenCalledWith(
      'https://preview.example.com/page',
      null,
    );
    expect(getPromptHash).toHaveBeenCalledWith(
      'v2:site-id:a cat',
      1024,
      1024,
    );
    expect(canAccessSite).not.toHaveBeenCalled();
    expect(enforceRequestRateLimit).not.toHaveBeenCalled();
    expect(acquireLock).not.toHaveBeenCalled();
  });

  it('does not generate an uncached image for an unauthenticated request', async () => {
    downloadFromCache.mockResolvedValue(null as never);

    const response = await GET(request(), context);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: 'Authentication is required to generate images',
    });
    expect(enforceRequestRateLimit).not.toHaveBeenCalled();
    expect(acquireLock).not.toHaveBeenCalled();
  });

  it('rechecks the cache under the generation lock before consuming quota', async () => {
    hasAuthenticatedPrincipal.mockReturnValue(true as never);
    downloadFromCache
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce({
        buffer: Buffer.from('concurrent-image'),
        mimeType: 'image/webp',
      } as never);

    const response = await GET(request('?site_id=site-id'), context);

    expect(response.status).toBe(200);
    expect(enforceRequestRateLimit).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(releaseLock).toHaveBeenCalledWith(
      'lock:public-image:image-hash',
      'lock-token',
    );
  });

  it('applies strict limits only when generation is actually required', async () => {
    hasAuthenticatedPrincipal.mockReturnValue(true as never);
    downloadFromCache.mockResolvedValue(null as never);
    enforceRequestRateLimit
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce(NextResponse.json(
        { error: 'Too many requests' },
        { status: 429 },
      ) as never);

    const response = await GET(request('?site_id=site-id'), context);

    expect(response.status).toBe(429);
    expect(enforceRequestRateLimit).toHaveBeenCalledTimes(2);
    expect(start).not.toHaveBeenCalled();
    expect(releaseLock).toHaveBeenCalled();
  });
});
