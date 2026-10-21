const create = jest.fn();
jest.mock('@/lib/status/telemetry', () => ({ recordTelemetry: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/services/ai/openrouter', () => ({
  createOpenRouterClient: () => ({ chat: { completions: { create } } }),
  getOpenRouterChatModel: () => 'test/model',
}));
import { createHarnessModel } from '../model';

beforeEach(() => create.mockReset());

it('roundtrips native tool identities and provider reasoning while explicitly bounding output', async () => {
  create.mockResolvedValue({ choices: [{ finish_reason: 'tool_calls', message: { content: '',
    tool_calls: [{ id: 'call-next', type: 'function', function: { name: 'read_files', arguments: '{}' } }],
    reasoning_details: [{ type: 'reasoning.text', text: 'synthetic reasoning' }] } }],
    usage: { prompt_tokens: 15, completion_tokens: 5, cost: 0.005 }, id: 'synthetic-generation', model: 'test/model' });
  const result = await createHarnessModel().respond({ system: 'work', tools: [], maxOutputTokens: 4096,
    signal: AbortSignal.timeout(1000), messages: [
      { role: 'assistant', content: '', toolCalls: [{ id: 'call-prev', name: 'exec', arguments: '{}' }], reasoningDetails: [{ type: 'reasoning.text', text: 'prior' }] },
      { role: 'tool', content: 'result', toolCallId: 'call-prev' },
    ] });
  expect(create.mock.calls[0][0]).toMatchObject({ max_tokens: 4096, model: 'test/model', messages: [
    { role: 'system' }, { role: 'assistant', reasoning_details: [{ text: 'prior' }] }, { role: 'tool', tool_call_id: 'call-prev' },
  ] });
  expect(result.message.toolCalls?.[0].id).toBe('call-next');
  expect(result.message.reasoningDetails).toEqual([{ type: 'reasoning.text', text: 'synthetic reasoning' }]);
  expect(result).toMatchObject({ usage: { inputTokens: 15, outputTokens: 5, cost: 0.005 }, generationId: 'synthetic-generation', model: 'test/model' });
});

it.each([
  { choices: [] },
  { choices: [{ finish_reason: 'content_filter', message: { content: 'rejected' } }] },
  { choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'bad-tool' }] } }] },
])('preserves authoritative billing evidence before malformed or rejected output raises', async malformed => {
  create.mockResolvedValue({ ...malformed, usage: { prompt_tokens: 3, completion_tokens: 4, cost: 0.006 }, id: 'synthetic-rejected', model: 'test/actual-model' });
  await expect(createHarnessModel().respond({ system: 'work', tools: [], messages: [], maxOutputTokens: 100,
    signal: new AbortController().signal })).rejects.toMatchObject({ usage: { inputTokens: 3, outputTokens: 4, cost: 0.006 },
      generationId: 'synthetic-rejected', model: 'test/actual-model' });
  expect(create).toHaveBeenCalledTimes(1);
});

it('marks confirmed admission rejection but never an ambiguous timeout as refundable', async () => {
  create.mockRejectedValueOnce({ status: 401 });
  const request = { system: 'work', tools: [], messages: [], maxOutputTokens: 100, signal: new AbortController().signal };
  await expect(createHarnessModel().respond(request)).rejects.toMatchObject({ status: 401, admissionRejected: true });
  const timeout = new Error('unknown outcome'); create.mockRejectedValueOnce(timeout);
  await expect(createHarnessModel().respond(request)).rejects.toBe(timeout);
  expect(timeout).not.toHaveProperty('admissionRejected');
});

it('preserves accepted-generation evidence returned on a provider error envelope', async () => {
  create.mockRejectedValue({ status: 503, error: { usage: { cost: 0.03, prompt_tokens: 5, completion_tokens: 2 },
    metadata: { generation_id: 'synthetic-error-generation', model: 'test/routed-model' } } });
  await expect(createHarnessModel().respond({ system: 'work', tools: [], messages: [], maxOutputTokens: 100,
    signal: new AbortController().signal })).rejects.toMatchObject({ usage: { cost: 0.03, inputTokens: 5, outputTokens: 2 },
      generationId: 'synthetic-error-generation', model: 'test/routed-model' });
  expect(create).toHaveBeenCalledTimes(1);
});

it('does not call a generation after cancellation during rejected admission backoff', async () => {
  const abort = new AbortController();
  create.mockImplementationOnce(async () => { abort.abort(); throw { status: 429 }; });
  await expect(createHarnessModel().respond({ system: 'work', tools: [], messages: [], maxOutputTokens: 100,
    signal: abort.signal })).rejects.toMatchObject({ admissionRejected: true });
  expect(create).toHaveBeenCalledTimes(1);
});

it('uses bounded admission retry in the real adapter after a transient 429', async () => {
  create.mockReset();
  create.mockRejectedValueOnce({ status: 429, headers: { 'retry-after': '0' } }).mockResolvedValue({
    choices: [{ finish_reason: 'stop', message: { content: 'Continue' } }], usage: { prompt_tokens: 3, completion_tokens: 2 },
  });
  const result = await createHarnessModel().respond({ system: 'work', messages: [], tools: [], maxOutputTokens: 256,
    signal: AbortSignal.timeout(5000) });
  expect(result.message.content).toBe('Continue'); expect(create).toHaveBeenCalledTimes(2);
});