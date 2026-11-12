import { randomBytes, randomUUID } from 'node:crypto';
import { summarizeInstanceContext, embedInstanceContext } from '@/lib/services/robot-instance/instance-context-inference';
import { withExecutionRouting, getCustomerCapability, getCustomerOperationKey } from '@/lib/services/ai/customer-routing';
import { EmbeddingsService } from '@/lib/services/embeddings-service';
import { AIAgentExecutor } from '@/lib/custom-automation/ai-agent-executor';

const mockAct = jest.fn();
jest.mock('@/lib/custom-automation/ai-agent-executor', () => ({ AIAgentExecutor: jest.fn(() => ({ act: mockAct })) }));
jest.mock('@/lib/services/embeddings-service', () => ({ EmbeddingsService: { generateEmbeddings: jest.fn() } }));
jest.mock('@/lib/integrations/openrouter/store', () => ({
  resolveCustomerCredential: jest.fn(async () => ({ apiKey: randomBytes(24).toString('hex'),
    capabilities: { summary: { mode: 'manual', status: 'available', modelId: 'customer/summary' } },
    catalog: [{ id: 'customer/summary', contextLength: 64000 }] })),
}));
const siteId = randomUUID();
const customer = { payer: 'customer' as const, siteId, connectionId: randomUUID(), policyVersion: 2, credentialVersion: 1 };
const input = { siteId, instanceId: randomUUID(), provider: 'openrouter' as const,
  model: 'global-model', previous: null, logs: 'Stable log data' };
const env = { ...process.env };
beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.OPENROUTER_API_KEY;
  mockAct.mockResolvedValue({ text: 'Summary' });
  jest.mocked(EmbeddingsService.generateEmbeddings).mockResolvedValue({ embeddings: [Array(1536).fill(0.1)], model: 'openai/text-embedding-3-small' });
});
afterEach(() => { process.env = { ...env }; });

it('summarizes using customer semantic capability without any global key and scopes embeddings separately', async () => {
  mockAct.mockImplementation(async () => {
    expect(getCustomerCapability()).toBe('summary');
    expect(getCustomerOperationKey()).toMatch(/^instance-summary:/);
    return { text: 'Summary' };
  });
  jest.mocked(EmbeddingsService.generateEmbeddings).mockImplementation(async () => {
    expect(getCustomerCapability()).toBeUndefined();
    return { embeddings: [Array(1536).fill(0.1)], model: 'openai/text-embedding-3-small' };
  });
  const result = await withExecutionRouting(customer, siteId, () => summarizeInstanceContext(input));
  expect(result?.summary).toBe('Summary');
  expect(AIAgentExecutor).toHaveBeenCalledWith({ provider: 'openrouter', model: 'customer/summary', siteId });
  expect(EmbeddingsService.generateEmbeddings).toHaveBeenCalledWith('Summary', 'openai/text-embedding-3-small', 1536);
});

it('keeps the global no-key compaction behavior unchanged', async () => {
  expect(await summarizeInstanceContext(input)).toBeNull();
  expect(mockAct).not.toHaveBeenCalled();
});

it('uses stable summary operation identity on replay', async () => {
  const operations: unknown[] = [];
  mockAct.mockImplementation(async () => { operations.push(getCustomerOperationKey()); return { text: 'Summary' }; });
  for (let i = 0; i < 2; i++) await withExecutionRouting(customer, siteId, () => summarizeInstanceContext(input));
  expect(operations[0]).toBe(operations[1]);
});

it('does not conceal a customer embedding capability failure or switch embedding spaces', async () => {
  jest.mocked(EmbeddingsService.generateEmbeddings).mockRejectedValue(new Error('incompatible embedding model'));
  await expect(withExecutionRouting(customer, siteId, () => summarizeInstanceContext(input))).rejects.toThrow('incompatible');
  await expect(embedInstanceContext('query')).rejects.toThrow('incompatible');
  expect(EmbeddingsService.generateEmbeddings).toHaveBeenLastCalledWith('query', 'openai/text-embedding-3-small', 1536);
});