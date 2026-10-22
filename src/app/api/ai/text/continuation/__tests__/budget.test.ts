import { randomBytes, randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { POST } from '../route';
import { continueJsonGeneration } from '@/lib/services/continuation-service';
import { analyzeWithConversationApi } from '@/lib/services/conversation-client';

jest.mock('@/lib/services/conversation-client', () => ({ analyzeWithConversationApi: jest.fn() }));

const request = (options: Record<string, unknown>) => new NextRequest('https://api.example.test/api/ai/text/continuation', {
  method: 'POST', body: JSON.stringify({ incompleteJson: '{"key":', modelType: 'openai', modelId: 'openai/test', siteUrl: '', ...options }),
});
beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

it.each([['3', 45000], [-1, 45000], [1.5, 45000], [4, 45000], [3, 0], [3, 120001], [3, '45000']])(
  'rejects invalid attempts=%s timeout=%s before calling a provider', async (maxRetries, timeout) => {
    expect((await POST(request({ maxRetries, timeout }))).status).toBe(400);
    expect(analyzeWithConversationApi).not.toHaveBeenCalled();
  },
);

it('honors zero paid attempts rather than replacing it with three', async () => {
  await POST(request({ maxRetries: 0 }));
  expect(analyzeWithConversationApi).not.toHaveBeenCalled();
});

it('passes the remaining total timeout and an abort signal to the real continuation adapter', async () => {
  const id = `gen-${randomUUID()}`;
  jest.mocked(analyzeWithConversationApi).mockResolvedValue({ id, model: 'openai/test',
    choices: [{ message: { content: '"done"}' } }], usage: { cost: 0.04 } });
  const result = await continueJsonGeneration({ incompleteJson: '{"key":', modelType: 'openai',
    modelId: 'openai/test', siteUrl: '', timeout: 400, maxRetries: 1 });
  expect(result.success).toBe(true);
  expect(result.generations).toEqual([expect.objectContaining({ id, usage: { cost: 0.04 } })]);
  const args = jest.mocked(analyzeWithConversationApi).mock.calls[0];
  expect(args[5]).toBeGreaterThan(0);
  expect(args[5]).toBeLessThanOrEqual(400);
  expect(args[9]).toBeInstanceOf(AbortSignal);
});

it('never replays inference after ambiguous transport failure or waits through all remaining attempts', async () => {
  const credential = randomBytes(24).toString('hex');
  jest.mocked(analyzeWithConversationApi).mockRejectedValue(new Error(credential));
  const result = await continueJsonGeneration({ incompleteJson: '{"key":', modelType: 'openai',
    modelId: 'openai/test', siteUrl: '', timeout: 100, maxRetries: 3 });
  expect(result.success).toBe(false);
  expect(result.retries).toBe(1);
  expect(result.outcomeUncertain).toBe(true);
  expect(analyzeWithConversationApi).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(result)).not.toContain(credential);
  expect(JSON.stringify(jest.mocked(console.error).mock.calls)).not.toContain(credential);
});

it('bounds even a non-cooperative adapter and does not submit another generation', async () => {
  jest.mocked(analyzeWithConversationApi).mockImplementation(() => new Promise(() => {}));
  const result = await continueJsonGeneration({ incompleteJson: '{"key":', modelType: 'openai',
    modelId: 'openai/test', siteUrl: '', timeout: 25, maxRetries: 3 });
  expect(result.success).toBe(false);
  expect(result.retries).toBe(1);
  expect(analyzeWithConversationApi).toHaveBeenCalledTimes(1);
});

it('keeps accepted-generation error evidence for reconciliation without replay', async () => {
  const id = `gen-${randomUUID()}`;
  jest.mocked(analyzeWithConversationApi).mockResolvedValue({ id, usage: { cost: 0.1 }, error: 'provider error' });
  const result = await continueJsonGeneration({ incompleteJson: '{"key":', modelType: 'openai',
    modelId: 'openai/test', siteUrl: '', timeout: 100, maxRetries: 3 });
  expect(analyzeWithConversationApi).toHaveBeenCalledTimes(1);
  expect(result.generations).toEqual([expect.objectContaining({ id, usage: { cost: 0.1 } })]);
});