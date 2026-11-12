import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { withAuthorizedCommandRequest } from '../command-http-routing';
import { getExecutionRouting, withCustomerOperation } from '../customer-routing';
import { beginCustomerInference } from '../../billing/customer-inference-receipts';
import { resolveToolRequestPrincipal, canToolPrincipalAccessSite } from '@/lib/security/tool-request-principal';
import { getCustomerSelection, resolveCustomerCredential } from '@/lib/integrations/openrouter/store';
import { supabaseAdmin } from '@/lib/database/supabase-client';
jest.mock('@/lib/security/tool-request-principal', () => ({ resolveToolRequestPrincipal: jest.fn(), canToolPrincipalAccessSite: jest.fn() }));
jest.mock('@/lib/integrations/openrouter/types', () => ({ rolloutEnabled: () => true }));
jest.mock('@/lib/integrations/openrouter/store', () => ({ getCustomerSelection: jest.fn(), resolveCustomerCredential: jest.fn() }));
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { rpc: jest.fn() } }));
const siteId = randomUUID(), actor = randomUUID();
const ref = { payer: 'customer' as const, siteId, connectionId: randomUUID(), policyVersion: 1, credentialVersion: 1 };
const request = (body: object = { site_id: siteId }) => new Request('https://api.example.test/api/agents/chat/message', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(resolveToolRequestPrincipal).mockResolvedValue({ internal: false, userId: actor, siteId });
  jest.mocked(canToolPrincipalAccessSite).mockResolvedValue(true);
  jest.mocked(getCustomerSelection).mockResolvedValue(ref as any);
  jest.mocked(resolveCustomerCredential).mockResolvedValue({} as any);
});

it('establishes selected routing only after principal/site admission and preserves the original body', async () => {
  const body = { site_id: siteId, message: 'hello', payer: 'platform' };
  const handler = jest.fn(async (r: Request) => {
    expect(getExecutionRouting()).toEqual(ref);
    expect(await r.json()).toEqual(body);
    return Response.json({ done: true });
  });
  expect((await withAuthorizedCommandRequest(request(body), handler)).status).toBe(200);
  expect(canToolPrincipalAccessSite).toHaveBeenCalledWith(expect.objectContaining({ userId: actor }), siteId);
  expect(getExecutionRouting()).toBeUndefined();
});

it('denies unauthenticated and cross-tenant actors before handler or privileged selection reads', async () => {
  const handler = jest.fn();
  jest.mocked(resolveToolRequestPrincipal).mockResolvedValue(null);
  expect((await withAuthorizedCommandRequest(request(), handler)).status).toBe(401);
  jest.mocked(resolveToolRequestPrincipal).mockResolvedValue({ internal: false, userId: actor, siteId });
  jest.mocked(canToolPrincipalAccessSite).mockResolvedValue(false);
  expect((await withAuthorizedCommandRequest(request(), handler)).status).toBe(403);
  expect(handler).not.toHaveBeenCalled();
  expect(getCustomerSelection).not.toHaveBeenCalled();
});

it('retains resource-specific denial without dispatch and refuses site-less service commands', async () => {
  expect((await withAuthorizedCommandRequest(request(), async () => Response.json({ error: 'role denied' }, { status: 403 }))).status).toBe(403);
  jest.mocked(resolveToolRequestPrincipal).mockResolvedValue({ internal: true, userId: null, siteId: null });
  expect((await withAuthorizedCommandRequest(request({}), jest.fn())).status).toBe(400);
});

it('bounds streamed command bodies before admission and preserves malformed-JSON status', async () => {
  const handler = jest.fn();
  expect((await withAuthorizedCommandRequest(new Request('https://api.example.test', { method: 'POST', body: '{' }), handler)).status).toBe(400);
  expect((await withAuthorizedCommandRequest(request({ site_id: siteId, text: 'x'.repeat(1024 * 1024) }), handler)).status).toBe(413);
  expect(handler).not.toHaveBeenCalled();
  expect(getCustomerSelection).not.toHaveBeenCalled();
});

it('immediate HTTP child and queue resume use one durable intent, while same actor nesting keeps ordinal', async () => {
  const keys = new Set<string>();
  jest.mocked(supabaseAdmin.rpc).mockImplementation((async (_name: string, { p_intent }: any) => {
    const claimed = !keys.has(p_intent.operation_key); keys.add(p_intent.operation_key);
    return { data: { claimed, event_id: p_intent.event_id }, error: null };
  }) as any);
  const dispatch = () => beginCustomerInference({ routing: ref, capability: 'text', requestedModel: 'vendor/model' });
  const child = () => withCustomerOperation('command:durable:execute', dispatch, { durableBoundary: true });
  await withCustomerOperation('random-http-request', child);
  await expect(child()).rejects.toThrow('do not replay');
  expect([...keys]).toEqual(['command:durable:execute:0']);
});

const routes = [
  'copywriter/content-calendar', 'copywriter/content-editor', 'copywriter/content-improve', 'chat/message',
  'sales/leadSelection', 'sales/message', 'sales/leadResearch', 'growth/campaigns/requirements',
  'cmo/dailyStandUp/sales', 'cmo/dailyStandUp/wrapUp', 'cmo/dailyStandUp/growth', 'cmo/dailyStandUp/system',
  'cmo/dailyStandUp/support', 'cmo/message', 'cmo/stakeholder-coordination', 'dataAnalyst/analysis',
  'dataAnalyst/leadSegmentation', 'dataAnalyst/leadContactGeneration', 'dataAnalyst/companyContactGeneration',
  'email', 'customerSupport/message',
];
it.each(routes)('pins the %s HTTP entrypoint and keeps split route/helper files bounded', route => {
  const dir = join(process.cwd(), 'src/app/api/agents', route);
  const source = readFileSync(join(dir, 'route.ts'), 'utf8');
  expect(source).toContain('withAuthorizedCommandRequest(request,');
  for (const file of readdirSync(dir).filter(f => f === 'route.ts' || /^command-(helpers|tools)/.test(f))) {
    expect(readFileSync(join(dir, file), 'utf8').split('\n').length).toBeLessThan(500);
  }
});

it('covers service callers through scoped parent and authenticates conversation-derived WhatsApp site', () => {
  const whatsapp = readFileSync(join(process.cwd(), 'src/app/api/integrations/whatsapp/agent/route.ts'), 'utf8');
  expect(whatsapp).toContain('authorizeInferenceRequest(request, metadata.siteId)');
  expect(whatsapp).toContain('withHttpExecutionRouting(request, routing!');
  expect(whatsapp).toContain(".eq('conversation_id', conversation_id)");
});