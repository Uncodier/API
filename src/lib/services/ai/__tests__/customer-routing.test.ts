import { randomBytes, randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import { createOpenRouterClient } from '../openrouter';
import { getExecutionRouting, resolveExecutionRouting, withExecutionRouting,
  requiresPlatformInferenceCredits, assertPlatformInference, type ExecutionRoutingReference } from '../customer-routing';
import { chargeOpenRouterUsage } from '../../billing/openrouter-usage-billing';
import { createRequirementAssistantBilling } from '@/app/api/robots/instance/assistant/requirement-billing';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { getCustomerSelection, resolveCustomerCredential } from '@/lib/integrations/openrouter/store';
import { AIAgentExecutor } from '@/lib/custom-automation/ai-agent-executor';

jest.mock('openai', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { rpc: jest.fn() } }));
jest.mock('@/lib/integrations/openrouter/store', () => ({
  getCustomerSelection: jest.fn(), resolveCustomerCredential: jest.fn(),
}));

const siteId = randomUUID();
const key = randomBytes(24).toString('hex');
const ref: ExecutionRoutingReference = { payer: 'customer', siteId,
  connectionId: randomUUID(), policyVersion: 3, credentialVersion: 2 };
const capability = { mode: 'manual', modelId: 'vendor/customer-model', status: 'unverified', reason: 'Offline' };
const credentials = { apiKey: key, capabilities: Object.fromEntries(
  ['text', 'tools', 'structured', 'vision', 'summary'].map(name => [name, { ...capability }])),
   catalog: [{ id: capability.modelId, contextLength: 128000, inputModalities:['text','image'], outputModalities:['text'], supportedParameters:['tools','structured_outputs'] }] };
const create = jest.fn();
const rpc = jest.mocked(supabaseAdmin.rpc);
const restore = (operation: () => Promise<any>) => withExecutionRouting(ref, siteId, operation);
const successfulRpc = async (name: string, args: any) => ({ error: null,
  data: name === 'openrouter_customer_dispatch' ? { claimed: true, event_id: args.p_intent.event_id } : null });

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(resolveCustomerCredential).mockResolvedValue(credentials as any);
  jest.mocked(getCustomerSelection).mockResolvedValue({ ...ref } as any);
  jest.mocked(OpenAI).mockImplementation(() => ({ chat: { completions: { create } } }) as any);
  rpc.mockImplementation(successfulRpc as any);
  create.mockResolvedValue({ id: 'generation-test', model: capability.modelId,
    usage: { cost: 0.01 }, choices: [{ message: { content: 'Done' }, finish_reason: 'stop' }] });
});

it('resolves a credential-free pinned reference; absence alone keeps global selection', async () => {
  expect(await resolveExecutionRouting(siteId)).toEqual(ref);
  expect(JSON.stringify(await resolveExecutionRouting(siteId))).not.toContain(key);
  jest.mocked(getCustomerSelection).mockResolvedValue(null);
  expect(await resolveExecutionRouting(siteId)).toEqual({ payer: 'platform', siteId });
  jest.mocked(getCustomerSelection).mockRejectedValue(new Error('outage'));
  await expect(resolveExecutionRouting(siteId)).rejects.toThrow('outage');
});

it('routes customer with no platform key, records external receipt, never charges platform', async () => {
  await restore(async () => {
    expect(requiresPlatformInferenceCredits(siteId)).toBe(false);
    const client = createOpenRouterClient({ env: {} });
    const result = await client.chat.completions.create({ model: 'ignored/global', messages: [], stream: false });
    await chargeOpenRouterUsage({ siteId, eventId: randomUUID(), usage: result.usage, generationId: result.id });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: capability.modelId,
      provider: { allow_fallbacks: false, require_parameters: true } }), expect.objectContaining({ maxRetries: 0 }));
    expect(jest.mocked(OpenAI).mock.calls[0][0]?.apiKey).toBe(key);
    expect(rpc.mock.calls.map(call => call[0])).toEqual(['openrouter_customer_dispatch', 'openrouter_customer_receipt']);
    expect(JSON.stringify(rpc.mock.calls)).not.toContain(key);
  });
  expect(requiresPlatformInferenceCredits(siteId)).toBe(true);
});

it('uses the primary model for combined capabilities even when independent pins differ',async()=>{
  const mixed={...credentials,capabilities:{...credentials.capabilities,structured:{...capability,modelId:'vendor/structured-only'}},
    catalog:[...credentials.catalog,{id:'vendor/structured-only',contextLength:128000,inputModalities:['text'],outputModalities:['text'],supportedParameters:['structured_outputs']}]};
  jest.mocked(resolveCustomerCredential).mockResolvedValue(mixed as never);
  await restore(async()=>{
    await createOpenRouterClient().chat.completions.create({model:'ignored',messages:[],tools:[{type:'function',function:{name:'test'}}],response_format:{type:'json_object'}});
  });
  expect(create).toHaveBeenCalledWith(expect.objectContaining({model:capability.modelId}),expect.any(Object));
});

it('denies a combined request when the primary model lacks its secondary contract',async()=>{
  jest.mocked(resolveCustomerCredential).mockResolvedValue({...credentials,catalog:[{...credentials.catalog[0],supportedParameters:['tools']}]} as never);
  await restore(async()=>{
    await expect(createOpenRouterClient().chat.completions.create({model:'ignored',messages:[],tools:[{type:'function',function:{name:'test'}}],response_format:{type:'json_object'}})).rejects.toMatchObject({code:'CUSTOMER_COMBINED_CAPABILITY_UNSUPPORTED'});
  });
  expect(create).not.toHaveBeenCalled();expect(rpc).not.toHaveBeenCalled();
});

it('rejects empty/revoked credentials at dispatch without global fallback', async () => {
  await restore(async () => {
    const client = createOpenRouterClient();
    jest.mocked(resolveCustomerCredential).mockResolvedValue({ ...credentials, apiKey: '' } as any);
    await expect(client.chat.completions.create({ model: 'ignored', messages: [] })).rejects.toThrow('platform fallback');
    expect(OpenAI).not.toHaveBeenCalled();
  });
});

it('denies cross-site restore and child payer changes, keeps parallel scopes isolated', async () => {
  await expect(withExecutionRouting(ref, randomUUID(), async () => null)).rejects.toThrow();
  expect(resolveCustomerCredential).not.toHaveBeenCalled();
  await restore(async () => {
    await expect(withExecutionRouting({ payer: 'platform', siteId }, siteId, async () => null)).rejects.toThrow();
    expect(() => requiresPlatformInferenceCredits(randomUUID())).toThrow();
  });
  await Promise.all([restore(async () => {
    await Promise.resolve(); expect(getExecutionRouting()?.payer).toBe('customer');
  }), withExecutionRouting({ payer: 'platform', siteId: 'another' }, 'another', async () => {
    await Promise.resolve(); expect(getExecutionRouting()?.payer).toBe('platform');
  })]);
});

it('blocks explicit credentials, unsupported methods and unreceipted billing exemption', async () => {
  await restore(async () => {
    expect(() => createOpenRouterClient({ apiKey: key })).toThrow();
    expect(() => createOpenRouterClient().embeddings).toThrow();
    expect(() => assertPlatformInference('image')).toThrow();
    await expect(chargeOpenRouterUsage({ siteId, eventId: randomUUID(), usage: { is_byok: true, cost: 0 } })).rejects.toThrow('reconciliation');
    expect(rpc).not.toHaveBeenCalled();
  });
});

it('does not replay or charge platform after receipt failure or uncertain provider timeout', async () => {
  await restore(async () => {
    rpc.mockImplementation((async (name: string, args: any) => name === 'openrouter_customer_receipt'
      ? { error: new Error('write failure') } : successfulRpc(name, args)) as any);
    await expect(createOpenRouterClient().chat.completions.create({ model: 'ignored', messages: [] })).rejects.toThrow('do not replay');
    expect(create).toHaveBeenCalledTimes(1);
  });
  create.mockRejectedValue(new Error('timeout'));
  rpc.mockImplementation(successfulRpc as any);
  await restore(async () => {
    await expect(createOpenRouterClient().chat.completions.create({ model: 'ignored', messages: [] })).rejects.toThrow('do not replay');
    expect(rpc.mock.calls.at(-1)?.[1]).toEqual({ p_receipt: expect.objectContaining({ state: 'uncertain' }) });
  });
  expect(rpc.mock.calls.every(call => ['openrouter_customer_dispatch', 'openrouter_customer_receipt'].includes(call[0]))).toBe(true);
});

it('keeps requirement ownership checks but makes no credit reservations', async () => {
  await restore(async () => {
    const active = jest.fn().mockResolvedValue(undefined);
    const billing = createRequirementAssistantBilling({ siteId } as any, active);
    await billing.beforeDispatch({ eventId: randomUUID(), inputBytes: 10, maxOutputTokens: 20 });
    expect(active).toHaveBeenCalledTimes(1);
    expect(rpc).not.toHaveBeenCalled();
    const result = await createOpenRouterClient().chat.completions.create({ model: 'ignored', messages: [], stream: false });
    await billing.settle({ eventId: randomUUID(), usage: result.usage, generationId: result.id });
    expect(rpc.mock.calls.map(call => call[0])).toEqual(['openrouter_customer_dispatch', 'openrouter_customer_receipt']);
  });
});

it('records stream receipt before settlement and partial streams as uncertain', async () => {
  create.mockImplementation(async () => (async function* () {
    yield { id: 'stream-test', usage: { cost: 0.02 }, choices: [] };
    yield { id: 'stream-test', choices: [] };
  })());
  await restore(async () => {
    const stream = await createOpenRouterClient().chat.completions.create({ model: 'ignored', messages: [], stream: true });
    for await (const _chunk of stream) break;
    expect(rpc.mock.calls.at(-1)?.[1]).toEqual({ p_receipt: expect.objectContaining({ state: 'uncertain' }) });
  });
});

it('runs the real main executor and nested helper with zero platform charges', async () => {
  await restore(async () => {
    const executor = new AIAgentExecutor({ siteId });
    const result = await executor.act({ prompt: 'Offline task', tools: [], maxIterations: 1 });
    expect(result.text).toBe('Done');
    const nested = new AIAgentExecutor({ siteId });
    await nested.act({ prompt: 'Offline summary', tools: [], maxIterations: 1 });
    expect(create).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls.map(call => call[0])).toEqual(['openrouter_customer_dispatch', 'openrouter_customer_receipt', 'openrouter_customer_dispatch', 'openrouter_customer_receipt']);
  });
});

it('preserves client and receipt identity across nested restoration of the same pinned reference', async () => {
  await restore(async () => {
    const client = createOpenRouterClient();
    await restore(async () => {
      const result = await client.chat.completions.create({ model: 'ignored', messages: [], stream: false });
      await chargeOpenRouterUsage({ siteId, eventId: randomUUID(), usage: result.usage, generationId: result.id });
    });
  });
  expect(rpc).toHaveBeenCalledTimes(2);
});

it('treats stream EOF without terminal event as uncertain, not successful completion', async () => {
  create.mockResolvedValue((async function* () { yield { id: 'incomplete', choices: [], usage: { cost: 0 } }; })());
  await restore(async () => {
    const stream = await createOpenRouterClient().chat.completions.create({ model: 'ignored', messages: [], stream: true });
    await expect((async () => { for await (const _chunk of stream) { /* Consume fully. */ } })()).rejects.toThrow('do not replay');
    expect(rpc.mock.calls.at(-1)?.[1]).toEqual({ p_receipt: expect.objectContaining({ state: 'uncertain' }) });
  });
});

it('fails closed when the selected model disappears or its real context budget is exceeded', async () => {
  await restore(async () => {
    jest.mocked(resolveCustomerCredential).mockResolvedValue({ ...credentials, catalog: [] } as any);
    await expect(createOpenRouterClient().chat.completions.create({ model: 'ignored', messages: [] })).rejects.toThrow();
    jest.mocked(resolveCustomerCredential).mockResolvedValue({ ...credentials,
      catalog: [{ id: capability.modelId, contextLength: 100 }] } as any);
    await expect(createOpenRouterClient().chat.completions.create({ model: 'ignored', messages: [], max_tokens: 101 })).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });
});

it('does not exempt an ordinary global call based on provider is_byok or zero cost', async () => {
  rpc.mockResolvedValue({ data: { success: true }, error: null } as any);
  await chargeOpenRouterUsage({ siteId, eventId: randomUUID(), usage: { cost: 0, is_byok: true } });
  expect(rpc.mock.calls.map(call => call[0])).toEqual(['bill_openrouter_generation']);
});

it('blocks a pre-created global transport inside customer scope before fetch', async () => {
  createOpenRouterClient({ env: { OPENROUTER_API_KEY: randomBytes(24).toString('hex') } });
  const transport = jest.mocked(OpenAI).mock.calls[0][0]?.fetch;
  expect(transport).toBeDefined();
  await restore(async () => {
    expect(() => transport!('https://example.invalid', {} as any)).toThrow('platform fallback');
  });
});

it('reports customer funding rejection from the real executor without requesting platform top-up', async () => {
  create.mockRejectedValue({ status: 402, error: { message: 'provider-private-error' } });
  await restore(async () => {
    await expect(new AIAgentExecutor({ siteId }).act({ prompt: 'Offline', tools: [], maxIterations: 1 }))
      .rejects.toMatchObject({ code: 'CUSTOMER_FUNDING_REQUIRED' });
    expect(create).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls.map(call => call[0])).toEqual(['openrouter_customer_dispatch', 'openrouter_customer_dispatch_reject']);
  });
});