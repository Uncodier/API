import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';

const start = jest.fn();
const getPromptHash = jest.fn<typeof import('@/lib/services/image/promptImageCache').getPromptHash>(() => 'image-hash');
const downloadFromCache = jest.fn();
const resolveSiteFromRequirementUrl = jest.fn();
const hasAuthenticatedPrincipal = jest.fn();
const isInternalServiceRequest = jest.fn();
const enforceRequestRateLimit = jest.fn();
const verifyPublicImageSignature = jest.fn();
const canAccessSite = jest.fn();
const acquireLock = jest.fn();
const releaseLock = jest.fn();

jest.mock('workflow/api', () => ({ start }));
jest.mock('../workflow', () => ({ generatePromptImageWorkflow: jest.fn() }));
jest.mock('@/lib/services/image/promptImageCache', () => ({
  getPromptHash,
  downloadFromCache,
}));
jest.mock('@/lib/services/image/resolveSiteFromRequirementUrl', () => ({
  resolveSiteFromRequirementUrl,
}));
jest.mock('@/lib/security/request-rate-limit', () => ({
  hasAuthenticatedPrincipal,
  isInternalServiceRequest,
  enforceRequestRateLimit,
}));
jest.mock('@/lib/security/public-image-signature', () => ({
  verifyPublicImageSignature,
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

function request(
  query = '',
  referer = 'https://preview.example.test/page',
  headers: Record<string, string> = {},
) {
  return new NextRequest(
    `https://backend.example.test/api/public/image/prompt/a%20cat${query}`,
    { headers: { referer, ...headers } },
  );
}

describe('public prompt image route caching', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resolveSiteFromRequirementUrl.mockResolvedValue('site-id' as never);
    hasAuthenticatedPrincipal.mockReturnValue(false as never);
    isInternalServiceRequest.mockReturnValue(false as never);
    canAccessSite.mockResolvedValue(true as never);
    acquireLock.mockResolvedValue({
      state: 'acquired',
      token: 'lock-token',
    } as never);
    releaseLock.mockResolvedValue({ state: 'released' } as never);
    enforceRequestRateLimit.mockResolvedValue(null as never);
    verifyPublicImageSignature.mockReturnValue(false as never);
  });

  it.each(['openrouter', 'gemini', 'vercel'])('rejects non-Azure provider query %s without opening a workflow or alias', async provider => {
    const response = await GET(request(`?provider=${provider}&model=raw-deployment`), context);
    expect(response.status).toBe(400);
    expect(start).not.toHaveBeenCalled();
    expect(downloadFromCache).not.toHaveBeenCalled();
  });

  it('accepts an explicit Azure provider without bypassing existing cache/site ownership', async () => {
    downloadFromCache.mockResolvedValue({ buffer: Buffer.from('cached-image'), mimeType: 'image/png' } as never);
    const response = await GET(request('?provider=azure'), context);
    expect(response.status).toBe(200);
    expect(getPromptHash).toHaveBeenCalledWith('v2:site-id:a cat', 1024, 1024);
    expect(start).not.toHaveBeenCalled();
  });

  it.each<[number, number, '256x256' | '512x512']>([[256, 256, '256x256'], [400, 400, '512x512'], [512, 512, '512x512']])('keeps tiny %sx%s cache requests while passing legacy size %s for normalization', async (width, height, size) => {
    hasAuthenticatedPrincipal.mockReturnValue(true as never);
    downloadFromCache.mockResolvedValueOnce(null as never).mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce({ buffer: Buffer.from('generated-image'), mimeType: 'image/png' } as never);
    start.mockResolvedValue({ returnValue: Promise.resolve({ status: 'completed' }) } as never);
    const response = await GET(request(`?provider=azure&site_id=site-id&width=${width}&height=${height}`), context);
    expect(response.status).toBe(200);
    expect(getPromptHash).toHaveBeenCalledWith('v2:site-id:a cat', width, height);
    expect(start).toHaveBeenCalledWith(expect.any(Function), [expect.objectContaining({ siteId: 'site-id', size, ratio: '1:1' })]);
    expect(canAccessSite).toHaveBeenCalledWith(expect.any(NextRequest), 'site-id');
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
      'https://preview.example.test/page',
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

  it('does not serve or generate Azure images when the authenticated principal lacks site access', async () => {
    hasAuthenticatedPrincipal.mockReturnValue(true as never);
    canAccessSite.mockResolvedValue(false as never);
    const response = await GET(request('?provider=azure&site_id=site-id'), context);
    expect(response.status).toBe(403);
    expect(downloadFromCache).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(enforceRequestRateLimit).not.toHaveBeenCalled();
  });

  it('allows SYSTEM funding only for a real authenticated internal service', async () => {
    hasAuthenticatedPrincipal.mockReturnValue(true as never);
    isInternalServiceRequest.mockReturnValue(true as never);
    downloadFromCache
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce({
        buffer: Buffer.from('platform-funded-image'),
        mimeType: 'image/jpeg',
      } as never);
    start.mockReturnValue({
      returnValue: Promise.resolve({ status: 'completed' }),
    } as never);

    const response = await GET(request(
      '',
      'https://app.makinari.com/sites/site-id/instances/instance-id',
    ), context);

    expect(response.status).toBe(200);
    expect(getPromptHash).toHaveBeenCalledWith(
      'v2:00000000-0000-0000-0000-000000000000:a cat',
      1024,
      1024,
    );
    expect(resolveSiteFromRequirementUrl).not.toHaveBeenCalled();
    expect(verifyPublicImageSignature).not.toHaveBeenCalled();
    expect(canAccessSite).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledWith(
      expect.any(Function),
      [expect.objectContaining({
        siteId: '00000000-0000-0000-0000-000000000000',
        prompt: 'a cat',
      })],
    );
  });

  it('does not regenerate site-scoped catalog images requested from the app', async () => {
    downloadFromCache.mockResolvedValue(null as never);

    const response = await GET(request(
      '?site_id=catalog-site&width=400&height=400',
      'https://app.makinari.com/sites/catalog-site/point-of-sale',
    ), context);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: 'Cached image not found',
    });
    expect(getPromptHash).toHaveBeenCalledWith(
      'v2:catalog-site:a cat',
      400,
      400,
    );
    expect(acquireLock).not.toHaveBeenCalled();
    expect(enforceRequestRateLimit).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it('preserves unsigned app catalog delivery of existing public cache', async () => {
    downloadFromCache.mockResolvedValue({ buffer: Buffer.from('catalog-image'), mimeType: 'image/png' } as never);
    const response = await GET(request('?site_id=catalog-site', '', { origin: 'https://app.makinari.com', referer: 'https://app.makinari.com/page' }), context);
    expect(response.status).toBe(200);
    expect(getPromptHash).toHaveBeenCalledWith('v2:catalog-site:a cat', 1024, 1024);
    expect(start).not.toHaveBeenCalled();
  });

  it('does not expose credentials from workflow failures in logs or HTTP errors', async () => {
    const secret = randomBytes(32).toString('hex');
    const remote = new URL('https://provider.example.invalid/image');
    remote.username = randomBytes(12).toString('hex');
    remote.password = randomBytes(32).toString('hex');
    remote.searchParams.set('token', randomBytes(32).toString('hex'));
    hasAuthenticatedPrincipal.mockReturnValue(true as never);
    downloadFromCache.mockResolvedValue(null as never);
    start.mockResolvedValue({ returnValue: Promise.reject(new Error(`${secret} ${remote}`)) } as never);
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await GET(request('?site_id=site-id'), context);
      expect(response.status).toBe(502);
      const output = JSON.stringify({ body: await response.json(), logs: log.mock.calls });
      for (const value of [secret, remote.username, remote.password, remote.searchParams.get('token')!, remote.toString()]) {
        expect(output).not.toContain(value);
      }
    } finally { log.mockRestore(); }
  });

  it('allows a valid signed request to enter the generation flow', async () => {
    const signature = randomBytes(32).toString('hex');
    verifyPublicImageSignature.mockReturnValue(true as never);
    downloadFromCache
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce({
        buffer: Buffer.from('generated-by-peer'),
        mimeType: 'image/jpeg',
      } as never);

    const response = await GET(request(
      `?site_id=site-id&expires=123&signature=${signature}`,
    ), context);

    expect(response.status).toBe(200);
    expect(verifyPublicImageSignature).toHaveBeenCalledWith(
      {
        siteId: 'site-id',
        prompt: 'a cat',
        width: 1024,
        height: 1024,
      },
      '123',
      signature,
    );
    expect(resolveSiteFromRequirementUrl).not.toHaveBeenCalled();
    expect(canAccessSite).not.toHaveBeenCalled();
    expect(acquireLock).toHaveBeenCalled();
  });

  it.each<Record<string, string>>([
    { origin: 'https://app.makinari.com' },
    { referer: 'https://app.makinari.com/sites/site-id' },
    { origin: 'https://app.makinari.com', referer: 'https://app.makinari.com/sites/site-id' },
    { origin: 'https://preview.example.test', referer: 'https://preview.example.test/page' },
  ])('never authenticates a cache miss using spoofed headers %j', async headers => {
    downloadFromCache.mockResolvedValue(null as never);
    const response = await GET(request('', '', headers), context);
    expect(response.status).toBe(401);
    expect(start).not.toHaveBeenCalled();
    expect(acquireLock).not.toHaveBeenCalled();
    expect(enforceRequestRateLimit).not.toHaveBeenCalled();
  });

  it('preserves unsigned/no-site app delivery of existing SYSTEM cache without spending', async () => {
    downloadFromCache.mockResolvedValue({ buffer: Buffer.from('existing-system'), mimeType: 'image/png' } as never);
    const response = await GET(request('', '', { origin: 'https://app.makinari.com', referer: 'https://app.makinari.com/page' }), context);
    expect(response.status).toBe(200);
    expect(getPromptHash).toHaveBeenCalledWith('v2:00000000-0000-0000-0000-000000000000:a cat', 1024, 1024);
    expect(start).not.toHaveBeenCalled();
    expect(acquireLock).not.toHaveBeenCalled();
  });

  it('does not turn an authenticated user plus app headers into SYSTEM funding', async () => {
    hasAuthenticatedPrincipal.mockReturnValue(true as never);
    downloadFromCache.mockResolvedValue(null as never);
    const response = await GET(request('', '', { origin: 'https://app.makinari.com', referer: 'https://app.makinari.com/page' }), context);
    expect(response.status).toBe(401);
    expect(start).not.toHaveBeenCalled();
    expect(acquireLock).not.toHaveBeenCalled();
  });

  it('verifies a real signed app request against the supplied tenant, not SYSTEM', async () => {
    const oldSecret = process.env.PUBLIC_MEDIA_SIGNING_SECRET;
    process.env.PUBLIC_MEDIA_SIGNING_SECRET = randomBytes(32).toString('hex');
    const signing = jest.requireActual<typeof import('@/lib/security/public-image-signature')>('@/lib/security/public-image-signature');
    const issued = signing.issuePublicImageSignature({ siteId: 'signed-tenant', prompt: 'a cat', width: 1024, height: 1024 });
    verifyPublicImageSignature.mockImplementation(signing.verifyPublicImageSignature as any);
    const url = new URL('https://backend.example.test/api/public/image/prompt/a%20cat');
    url.searchParams.set('site_id', 'signed-tenant');
    url.searchParams.set('expires', String(issued.expires));
    url.searchParams.set('signature', issued.signature);
    downloadFromCache.mockResolvedValueOnce(null as never).mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce({ buffer: Buffer.from('tenant-generated'), mimeType: 'image/png' } as never);
    start.mockResolvedValue({ returnValue: Promise.resolve({ status: 'completed' }) } as never);
    try {
      const response = await GET(new NextRequest(url, { headers: { origin: 'https://app.makinari.com', referer: 'https://app.makinari.com/page' } }), context);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(getPromptHash).toHaveBeenCalledWith('v2:signed-tenant:a cat', 1024, 1024);
      expect(start).toHaveBeenCalledWith(expect.any(Function), [expect.objectContaining({ siteId: 'signed-tenant' })]);
      expect(resolveSiteFromRequirementUrl).not.toHaveBeenCalled();
      // Tampering with tenant invalidates the capability, even with both app headers.
      url.searchParams.set('site_id', 'other-tenant');
      downloadFromCache.mockResolvedValue(null as never);
      start.mockClear();
      expect((await GET(new NextRequest(url, { headers: { origin: 'https://app.makinari.com', referer: 'https://app.makinari.com/page' } }), context)).status).toBe(404);
      expect(start).not.toHaveBeenCalled();
    } finally {
      if (oldSecret === undefined) delete process.env.PUBLIC_MEDIA_SIGNING_SECRET;
      else process.env.PUBLIC_MEDIA_SIGNING_SECRET = oldSecret;
    }
  });

  it.each([false, true])('requires canAccessSite for authenticated app tenant even with signed=%s', async signed => {
    hasAuthenticatedPrincipal.mockReturnValue(true as never);
    verifyPublicImageSignature.mockReturnValue(signed as never);
    canAccessSite.mockResolvedValue(false as never);
    downloadFromCache.mockResolvedValue({ buffer: Buffer.from('private-cache'), mimeType: 'image/png' } as never);
    const response = await GET(request('?site_id=other-tenant', '', { origin: 'https://app.makinari.com', referer: 'https://app.makinari.com/page' }), context);
    expect(response.status).toBe(403);
    expect(canAccessSite).toHaveBeenCalledWith(expect.any(NextRequest), 'other-tenant');
    expect(downloadFromCache).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it('allows an authorized app tenant cache miss charged to that tenant', async () => {
    hasAuthenticatedPrincipal.mockReturnValue(true as never);
    downloadFromCache.mockResolvedValueOnce(null as never).mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce({ buffer: Buffer.from('tenant-generated'), mimeType: 'image/png' } as never);
    start.mockResolvedValue({ returnValue: Promise.resolve({ status: 'completed' }) } as never);
    const response = await GET(request('?site_id=site-id', '', { origin: 'https://app.makinari.com', referer: 'https://app.makinari.com/page' }), context);
    expect(response.status).toBe(200);
    expect(canAccessSite).toHaveBeenCalledWith(expect.any(NextRequest), 'site-id');
    expect(start).toHaveBeenCalledWith(expect.any(Function), [expect.objectContaining({ siteId: 'site-id' })]);
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
