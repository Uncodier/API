const create = jest.fn();
jest.mock('@/lib/services/ai/openrouter', () => ({
  createOpenRouterClient: () => ({ chat: { completions: { create } } }),
  getOpenRouterChatModel: () => 'test/model',
}));
import { createHarnessModel } from '../model';

it('roundtrips native tool identities and provider reasoning while explicitly bounding output', async () => {
  create.mockResolvedValue({ choices: [{ finish_reason: 'tool_calls', message: { content: '',
    tool_calls: [{ id: 'call-next', type: 'function', function: { name: 'read_files', arguments: '{}' } }],
    reasoning_details: [{ type: 'reasoning.text', text: 'synthetic reasoning' }] } }],
    usage: { prompt_tokens: 15, completion_tokens: 5 } });
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