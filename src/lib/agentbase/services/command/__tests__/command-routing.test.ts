import { randomUUID } from 'node:crypto';
import { admitCommandRouting, pinCommandRouting, withCommandRouting } from '../command-routing';
import { getExecutionRouting, getCustomerOperationKey, withExecutionRouting } from '@/lib/services/ai/customer-routing';
import { rolloutEnabled, routingStorageEnabled } from '@/lib/integrations/openrouter/types';

const rpc = jest.fn();
const maybeSingle = jest.fn();
const query = { select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), maybeSingle };
const from = jest.fn((..._args: unknown[]) => query);
jest.mock('@/lib/database/supabase-server', () => ({ supabaseAdmin: { rpc: (...a: unknown[]) => rpc(...a), from: (...a: unknown[]) => from(...a) } }));
jest.mock('@/lib/integrations/openrouter/store', () => ({ resolveCustomerCredential: jest.fn(async () => ({ apiKey: '' })) }));
jest.mock('@/lib/integrations/openrouter/types', () => ({ rolloutEnabled: jest.fn(), routingStorageEnabled: jest.fn() }));
const siteId = randomUUID();
const customer = { payer: 'customer' as const, siteId, connectionId: randomUUID(), policyVersion: 2, credentialVersion: 3 };
const command = { id: randomUUID(), site_id: siteId, user_id: randomUUID(), task: 'offline', status: 'pending' as const,
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(), metadata: { executionRouting: { payer: 'platform', siteId } } };

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(rolloutEnabled).mockReturnValue(false);
  jest.mocked(routingStorageEnabled).mockReturnValue(true);
  rpc.mockResolvedValue({ error: null });
  maybeSingle.mockResolvedValue({ data: { routing: customer }, error: null });
});

it('never trusts client metadata or user IDs to admit customer spending', () => {
  jest.mocked(rolloutEnabled).mockReturnValue(true);
  expect(() => admitCommandRouting(command)).toThrow('platform fallback is prohibited');
});
it('inherits host scope and rejects cross-site commands', async () => {
  await withExecutionRouting(customer, siteId, async () => {
    expect(admitCommandRouting(command)).toEqual(customer);
    expect(() => admitCommandRouting({ ...command, site_id: randomUUID() })).toThrow();
  });
});
it('pins before queue dispatch using the dedicated immutable RPC', async () => {
  await pinCommandRouting(command, customer);
  expect(rpc).toHaveBeenCalledWith('openrouter_command_routing_pin', { p_command_id: command.id, p_site_id: siteId, p_routing: customer });
});
it('restores durable customer attribution despite forged platform metadata and disabled admission', async () => {
  await withCommandRouting(command, async () => {
    expect(getExecutionRouting()).toEqual(customer);
    expect(getCustomerOperationKey()).toBe(`command:${command.id}:execute:0`);
  });
  await withCommandRouting(command, async () => expect(getCustomerOperationKey()).toBe(`command:${command.id}:execute:0`));
});
it.each([{ data: null, error: null }, { data: null, error: { code: '42P01' } }])('fails closed on missing pin/storage after deployment', async result => {
  maybeSingle.mockResolvedValue(result);
  await expect(withCommandRouting(command, async () => 'must not run')).rejects.toThrow();
});
it('preserves pre-schema platform behavior without accessing new storage', async () => {
  jest.mocked(routingStorageEnabled).mockReturnValue(false);
  await pinCommandRouting(command, { payer: 'platform', siteId });
  await withCommandRouting(command, async () => expect(getExecutionRouting()).toEqual({ payer: 'platform', siteId }));
  expect(from).not.toHaveBeenCalled(); expect(rpc).not.toHaveBeenCalled();
  await expect(pinCommandRouting(command, customer)).rejects.toThrow();
});
it('does not downgrade a customer parent or ignore persistence errors', async () => {
  rpc.mockResolvedValue({ error: { code: 'PGRST202' } });
  await expect(pinCommandRouting(command, customer)).rejects.toThrow();
  maybeSingle.mockResolvedValue({ data: { routing: { payer: 'platform', siteId } }, error: null });
  await expect(withExecutionRouting(customer, siteId, () => withCommandRouting(command, async () => true))).rejects.toThrow();
});