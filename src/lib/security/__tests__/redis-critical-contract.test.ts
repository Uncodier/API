import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from '@jest/globals';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('critical Redis failure contracts', () => {
  it.each([
    'src/app/api/agents/whatsapp/route.ts',
    'src/app/api/integrations/vercel/webhook/route.ts',
  ])('does not acknowledge unavailable Redis as a duplicate in %s', (path) => {
    const route = source(path);

    expect(route).toMatch(/claim\.state === ['"]contended['"]/);
    expect(route).toMatch(/claim\.state !== ['"]acquired['"]/);
    expect(route).toContain('503');
  });

  it.each([
    ['src/app/api/integrations/outstand/webhooks/route.ts', 'outstand'],
    ['src/app/api/integrations/stripe/webhook/route.ts', 'stripe'],
    ['src/app/api/integrations/whatsapp/webhook/post-handler.ts', 'meta-whatsapp'],
    ['src/app/api/integrations/zavu/webhook/route.ts', 'zavu'],
    [
      'src/app/api/agents/gear/whatsapp/webhook/twilio-webhook-auth.ts',
      'twilio-whatsapp-gear',
    ],
  ])('uses durable claims for %s', (path, provider) => {
    const route = source(path);

    expect(route).toContain('claimProviderWebhookEvent');
    expect(route).toContain('finishProviderWebhookEvent');
    expect(route).toContain(provider);
    expect(route).not.toContain('claimKey(');
    expect(route).not.toContain('deleteKey(');
  });

  it('uses a durable, token-fenced claim for Stripe', () => {
    const route = source(
      'src/app/api/integrations/stripe/webhook/route.ts',
    );

    expect(route).toContain("claimProviderWebhookEvent('stripe'");
    expect(route).toContain("finishProviderWebhookEvent(");
    expect(route).not.toContain('acquireLock(');
  });

  it('finishes Gear WhatsApp claims instead of deleting a Redis key', () => {
    const route = source(
      'src/app/api/agents/gear/whatsapp/webhook/route.ts',
    );

    expect(route).toContain('finishGearWebhookClaim');
    expect(route).not.toContain('deleteKey(');
  });

  it('uses owner-token release and fails closed for plan locks', () => {
    const steps = source(
      'src/app/api/robots/instance/assistant/plan-steps.ts',
    );

    expect(steps).toContain('const token = crypto.randomUUID()');
    expect(steps).toContain("redis.call('GET', KEYS[1]) == ARGV[1]");
    expect(steps).toContain("return { state: 'unavailable' }");
    expect(steps).not.toContain('await redis.del(lockKey)');
  });
});

describe('public generation cache authorization', () => {
  it.each([
    'src/app/api/public/icon/prompt/[...prompt]/route.ts',
    'src/app/api/public/image/prompt/[...prompt]/route.ts',
    'src/app/api/public/summary/prompt/[...prompt]/route.ts',
    'src/app/api/public/video/prompt/[...prompt]/route.ts',
  ])('authorizes and tenant-scopes cache access in %s', (path) => {
    const route = source(path);
    const authIndex = route.indexOf('hasAuthenticatedPrincipal(request)');
    const accessIndex = route.indexOf('canAccessSite(request, siteId)');
    const cacheIndex = route.indexOf('await download');

    expect(authIndex).toBeGreaterThan(-1);
    expect(accessIndex).toBeGreaterThan(authIndex);
    expect(cacheIndex).toBeGreaterThan(accessIndex);
    expect(route).toContain('v2:${siteId}:');
    expect(route).not.toContain("'Cache-Control': 'public,");
  });
});
