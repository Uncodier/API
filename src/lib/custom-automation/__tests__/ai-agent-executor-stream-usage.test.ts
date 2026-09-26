import { AIAgentExecutor } from '../ai-agent-executor';

function completionStream(chunks: unknown[]) {
  return (async function* () {
    for (const chunk of chunks) yield chunk;
  })();
}

describe('AIAgentExecutor streaming usage', () => {
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

  afterAll(() => {
    log.mockRestore();
    warn.mockRestore();
  });

  it('requests provider usage and passes each completion to billing exactly once', async () => {
    const executor = new AIAgentExecutor({ provider: 'openai', model: 'test-model', apiKey: 'test-key' });
    const create = jest.fn().mockResolvedValue(completionStream([
      { choices: [{ delta: { content: 'Hello' }, finish_reason: null }] },
      { choices: [{ delta: { content: ' world' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } },
      // The final usage-only chunk must replace, not add to, the preceding one.
      { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } },
    ]));
    (executor as any).client.chat.completions.create = create;
    const onContextUsage = jest.fn().mockResolvedValue(undefined);
    const onStreamStart = jest.fn().mockResolvedValue('stream-log');
    const onStreamChunk = jest.fn().mockResolvedValue(undefined);

    const result = await executor.act({ tools: [], system: 'System instructions', prompt: 'User question',
      stream: true, onStreamStart, onStreamChunk, onContextUsage, maxIterations: 1 });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toEqual(expect.objectContaining({
      stream: true, stream_options: { include_usage: true },
    }));
    expect(result.text).toBe('Hello world');
    expect(result.usage).toEqual({ promptTokens: 100, completionTokens: 20, totalTokens: 120 });
    expect(result.steps[0].usage).toEqual({ promptTokens: 100, completionTokens: 20, totalTokens: 120 });
    expect(onContextUsage).toHaveBeenCalledTimes(2);
    expect(onContextUsage.mock.calls[0][0]).not.toHaveProperty('providerOutputTokens');
    expect(onContextUsage.mock.calls[1][0]).toEqual(expect.objectContaining({
      providerInputTokens: 100, providerOutputTokens: 20,
    }));
    expect(onStreamChunk).toHaveBeenLastCalledWith('stream-log', 'Hello world', true);
  });

  it('keeps unknown streamed output distinct from a reported zero', async () => {
    const executor = new AIAgentExecutor({ provider: 'openai', model: 'test-model', apiKey: 'test-key' });
    const create = jest.fn().mockResolvedValue(completionStream([
      { choices: [{ delta: { content: 'Answer' }, finish_reason: 'stop' }] },
    ]));
    (executor as any).client.chat.completions.create = create;
    const onContextUsage = jest.fn().mockResolvedValue(undefined);
    const result = await executor.act({ tools: [], prompt: 'Question', stream: true,
      onStreamStart: async () => 'stream-log', onStreamChunk: async () => {},
      onContextUsage, maxIterations: 1 });

    expect(result.text).toBe('Answer');
    expect(onContextUsage).toHaveBeenCalledTimes(1);
    expect(onContextUsage.mock.calls[0][0]).not.toHaveProperty('providerOutputTokens');
    // No provider usage was reported; nothing should be charged as measured usage.
    expect(result.usage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  });
});