import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('webhook security contract', () => {
  it('fails closed when the Outstand signing secret is absent', () => {
    const route = source('src/app/api/integrations/outstand/webhooks/route.ts');
    expect(route).toContain('if (!secret)');
    expect(route).toContain("'Webhook secret not configured'");
    expect(route).toContain('verifyOutstandWebhookSignature');
  });

  it('verifies Meta signatures over the raw body before processing', () => {
    const handler = source(
      'src/app/api/integrations/whatsapp/webhook/post-handler.ts'
    );
    expect(handler).toContain("request.headers.get('x-hub-signature-256')");
    expect(handler).toContain("request.text()");
    expect(handler.indexOf('hasValidMetaSignature(rawBody, signature)'))
      .toBeLessThan(handler.indexOf('await processMessage('));
  });

  it('verifies Gear Twilio signatures before database access', () => {
    const route = source('src/app/api/agents/gear/whatsapp/webhook/route.ts');
    const authentication = source(
      'src/app/api/agents/gear/whatsapp/webhook/twilio-webhook-auth.ts'
    );
    expect(authentication).toContain("request.headers.get('x-twilio-signature')");
    expect(route.indexOf('authenticateGearWebhook(request)'))
      .toBeLessThan(route.indexOf("supabaseAdmin\n      .rpc("));
  });
});
