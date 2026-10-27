import { randomBytes, randomUUID } from 'node:crypto';
const rpc = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { rpc } }));
import { chargeOpenRouterUsage } from '../openrouter-usage-billing';
import { withRequirementChargeContext } from '../requirement-charge-context';

beforeEach(() => { jest.resetAllMocks(); rpc.mockResolvedValue({ data: { success: true }, error: null }); });

it('attributes nested model charges using private host context, not caller metadata', async () => {
  const context = { siteId: randomUUID(), requirementId: randomUUID(), sessionId: randomUUID() };
  await withRequirementChargeContext(context, () => chargeOpenRouterUsage({ siteId: context.siteId,
    eventId: randomUUID(), usage: { cost: 0.1 }, metadata: { requirement_id: randomUUID(), session_id: randomUUID() } }));
  expect(rpc.mock.calls[0][1].p_metadata).toMatchObject({ requirement_id: context.requirementId, session_id: context.sessionId });
});

it('submits only reported cost and a stable generation identity to the idempotent ledger', async () => {
  const siteId = randomUUID(), eventId = randomUUID();
  const input = { siteId, eventId, generationId: `gen-${randomUUID()}`, usage: { cost: 0.04 }, metadata: { instance_id: randomUUID() } };
  await chargeOpenRouterUsage(input);
  await chargeOpenRouterUsage(input);
  expect(rpc).toHaveBeenCalledTimes(2);
  expect(rpc.mock.calls[0]).toEqual(rpc.mock.calls[1]);
  expect(rpc).toHaveBeenCalledWith('bill_openrouter_generation', {
    p_site_id: siteId, p_event_id: input.generationId, p_provider_cost: 0.04,
    p_metadata: { ...input.metadata, gateway_account_cost: 0.04 },
  });
});

it('falls back to a host event identity, not a random identity created after dispatch', async () => {
  const input = { siteId: randomUUID(), eventId: randomUUID(), usage: { cost: 0 } };
  await chargeOpenRouterUsage(input);
  expect(rpc).toHaveBeenCalledWith('bill_openrouter_generation', expect.objectContaining({ p_event_id: input.eventId, p_provider_cost: 0 }));
});

it('does not persist raw usage, URLs, credentials or arbitrary provider metadata', async () => {
  const credential = randomBytes(24).toString('hex');
  const username = randomBytes(12).toString('hex');
  const url = new URL('https://provider.example.test/usage');
  url.username = username; url.password = credential;
  await chargeOpenRouterUsage({ siteId: randomUUID(), eventId: randomUUID(), usage: { cost: 0.01, apiKey: credential },
    metadata: { api_key: credential, url: url.href, usage: { cost: 0.01, secret: credential }, model: 'openai/gpt-6.1-sol' } });
  const serialized = JSON.stringify(rpc.mock.calls);
  expect(serialized).not.toContain(credential);
  expect(serialized).not.toContain(username);
  expect(serialized).not.toContain(url.href);
  expect(rpc.mock.calls[0][1].p_metadata).toEqual({ model: 'openai/gpt-6.1-sol', gateway_account_cost: 0.01 });
});

it('retains separate BYOK evidence without changing the customer tariff or trusting caller metadata', async () => {
  await chargeOpenRouterUsage({ siteId: randomUUID(), eventId: randomUUID(),
    usage: { cost: 0, is_byok: true, cost_details: { upstream_inference_cost: 0.07 } },
    metadata: { gateway_account_cost: 500, upstream_inference_cost: 900, is_byok: false },
  });
  expect(rpc).toHaveBeenCalledWith('bill_openrouter_generation', expect.objectContaining({
    p_provider_cost: 0,
    p_metadata: { gateway_account_cost: 0, is_byok: true, upstream_inference_cost: 0.07,
      external_cost_reconciliation_required: true },
  }));
});

it.each([undefined, {}, { cost: NaN }, { cost: -1 }])('persists unknown cost %j as pending, never substituting token prices', async usage => {
  await expect(chargeOpenRouterUsage({ siteId: randomUUID(), eventId: randomUUID(), usage })).rejects.toThrow('reconciliation');
  expect(rpc).toHaveBeenCalledWith('bill_openrouter_generation', expect.objectContaining({ p_provider_cost: null }));
});

it.each([{ data: null, error: null }, { data: { success: false }, error: null },
  { data: null, error: { message: 'synthetic untrusted provider error' } }])('stops on an unconfirmed ledger response %j', async result => {
  rpc.mockResolvedValue(result);
  await expect(chargeOpenRouterUsage({ siteId: randomUUID(), eventId: randomUUID(), usage: { cost: 0.01 } }))
    .rejects.toThrow('billing requires reconciliation');
  expect(rpc).toHaveBeenCalledTimes(1);
});

it('normalizes thrown transport errors without leaking synthetic credentials', async () => {
  const credential = randomBytes(24).toString('hex');
  rpc.mockRejectedValue(new Error(`synthetic transport ${credential}`));
  const error = await chargeOpenRouterUsage({ siteId: randomUUID(), eventId: randomUUID(), usage: { cost: 0.01 } })
    .catch(error => error);
  expect(error.name).toBe('OpenRouterBillingError');
  expect(error.message).toContain('reconciliation');
  expect(error.message).not.toContain(credential);
});