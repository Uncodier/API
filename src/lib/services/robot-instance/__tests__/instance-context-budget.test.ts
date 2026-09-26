import { estimateInputBreakdown, estimatePromptTokens, estimateTokens, fitInstanceRequest, InstanceContextOverflowError, measureInstanceContext, modelContextLimit, outputReserveForModel, projectNextTurn, readInputTokenBreakdown, resolveModelContextCapacity } from '../instance-context-budget';
import { selectTacticalLogs } from '../InstanceContextManager';

describe('instance context budget', () => {
  const previous = process.env.INSTANCE_CONTEXT_MODEL_LIMITS;
  afterEach(() => { process.env.INSTANCE_CONTEXT_MODEL_LIMITS = previous; });

  it('estimates non-overlapping input slices without sending prompt text in the breakdown', () => {
    const skill = '--- BEGIN SKILL safe (Safe, version 1) ---\nFollow checklist\n--- END SKILL safe ---';
    const messages = [
      { role: 'system', content: `Rules\n${skill}` },
      { role: 'user', content: 'What is next?' },
      { role: 'assistant', content: null, tool_calls: [{ function: { name: 'lookup', arguments: '{}' } }] },
      { role: 'tool', content: 'Found item' },
      { role: 'assistant', content: 'Finished' },
    ];
    const tools = [{ type: 'function', function: { name: 'lookup', description: 'Search' } }];
    const breakdown = estimateInputBreakdown('Rules', messages, tools);
    expect(breakdown.skills).toBeGreaterThan(0);
    expect(breakdown.messages).toBeGreaterThan(0);
    expect(breakdown.toolCalls).toBeGreaterThan(0);
    expect(breakdown.toolDefinitions).toBeGreaterThan(0);
    expect(breakdown.instructions).toBeGreaterThanOrEqual(0);
    expect(breakdown.instructions + breakdown.skills + breakdown.messages + breakdown.toolCalls + breakdown.toolDefinitions)
      .toBe(breakdown.estimatedInputTokens);
    expect(breakdown.estimatedInputTokens).toBe(estimatePromptTokens(messages) + estimateTokens(tools));
    expect(JSON.stringify(breakdown)).not.toContain('Follow checklist');
  });

  it('does not count large image base64 payloads as text in a category', () => {
    const result = estimateInputBreakdown('', [{ role: 'user', content: [
      { type: 'text', text: 'Look at this' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(500_000)}` } },
    ] }], []);
    expect(result.estimatedInputTokens).toBeLessThan(5000);
    expect(result.messages).toBeGreaterThan(4000);
  });

  it('keeps provider aggregate distinct from estimated sectors and rejects stale JSON', () => {
    const measurement = measureInstanceContext({ provider: 'azure', model: 'unknown', system: '',
      messages: [{ role: 'user', content: 'Hello' }], tools: [], providerInputTokens: 3000 });
    const json = { ...measurement.breakdown, usedTokens: 3000, source: measurement.source, measuredAt: measurement.measuredAt };
    expect(measurement.usedTokens).toBe(3000);
    expect(measurement.breakdown?.estimatedInputTokens).toBeLessThan(3000);
    expect(readInputTokenBreakdown(json, measurement.measuredAt, 3000, 'provider')).toEqual(measurement.breakdown);
    expect(readInputTokenBreakdown(json, measurement.measuredAt, 3001, 'provider')).toBeNull();
    expect(readInputTokenBreakdown({ ...json, prompt: 'leak' }, measurement.measuredAt, 3000, 'provider')).toBeNull();
    expect(readInputTokenBreakdown({ ...json, skills: 100000 }, measurement.measuredAt, 3000, 'provider')).toBeNull();
  });

  it('never invents an unknown model capacity', () => {
    delete process.env.INSTANCE_CONTEXT_MODEL_LIMITS;
    const measured = measureInstanceContext({ provider: 'azure', model: 'private-deployment',
      system: 'instructions', messages: [{ role: 'user', content: 'hello' }], tools: [] });
    expect(measured.availableTokens).toBeNull();
    expect(measured.utilization).toBeNull();
    expect(measured.source).toBe('estimate');
    expect(measured.usedTokens).toBeGreaterThan(0);
  });

  it('uses published maximum capacities for exact model IDs only', () => {
    delete process.env.INSTANCE_CONTEXT_MODEL_LIMITS;
    expect(modelContextLimit('gemini', 'gemini-3.1-pro-preview')).toBe(1_048_576);
    expect(modelContextLimit('gemini', 'gemini-3.1-pro-preview-customtools')).toBe(1_048_576);
    expect(outputReserveForModel('gemini', 'gemini-3.1-pro-preview')).toBe(0);
    expect(modelContextLimit('openai', 'gpt-4o')).toBe(128_000);
    expect(outputReserveForModel('openai', 'gpt-4o')).toBe(16_384);
    expect(modelContextLimit('openai', 'gpt-5.2')).toBe(400_000);
    expect(outputReserveForModel('openai', 'gpt-5.2')).toBe(128_000);
    expect(modelContextLimit('azure', 'gpt-5.2')).toBeNull();
    expect(modelContextLimit('azure', 'private-gpt52-deployment')).toBeNull();
    expect(modelContextLimit('xai', 'grok-4.6')).toBe(500_000);
    expect(modelContextLimit('azure', 'custom-production-deployment')).toBeNull();
    expect(modelContextLimit('xai', 'xai/grok-4.6')).toBeNull();
  });

  it('uses the full documented Gemini input limit instead of a 10% reduction', () => {
    delete process.env.INSTANCE_CONTEXT_MODEL_LIMITS;
    const result = fitInstanceRequest({ provider: 'gemini', model: 'gemini-3.1-pro-preview',
      messages: [{ role: 'user', content: 'hello' }], tools: [] });
    expect(result.inputBudget).toBe(1_048_576);
    expect(measureInstanceContext({ provider: 'gemini', model: 'gemini-3.1-pro-preview',
      system: '', messages: [], tools: [] }).reservedOutputTokens).toBe(0);
  });

  it('lets a custom Azure deployment declare its verified capacity explicitly', () => {
    process.env.INSTANCE_CONTEXT_MODEL_LIMITS = JSON.stringify({
      'azure:custom-production-deployment': { contextTokens: 128_000, outputTokens: 16_384 },
    });
    expect(modelContextLimit('azure', 'custom-production-deployment')).toBe(128_000);
    expect(outputReserveForModel('azure', 'custom-production-deployment')).toBe(16_384);
  });

  it('discovers exact Gemini IDs via model metadata without hardcoding a family-wide limit', async () => {
    const previousKey = process.env.GEMINI_API_KEY;
    const previousFetch = global.fetch;
    delete process.env.INSTANCE_CONTEXT_MODEL_LIMITS;
    process.env.GEMINI_API_KEY = 'unit-test-key';
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ inputTokenLimit: 262_144 }) });
    global.fetch = fetchMock as unknown as typeof fetch;
    try {
      expect(await resolveModelContextCapacity('gemini', 'gemini-test-exact-model')).toEqual({
        availableTokens: 262_144, reservedOutputTokens: 0,
      });
      expect(modelContextLimit('gemini', 'gemini-test-exact-model')).toBe(262_144);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-test-exact-model',
        expect.objectContaining({ headers: { 'x-goog-api-key': 'unit-test-key' } }),
      );
    } finally {
      global.fetch = previousFetch;
      if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = previousKey;
    }
  });

  it('does not enforce an invented 24k budget when the model is unconfigured', () => {
    delete process.env.INSTANCE_CONTEXT_MODEL_LIMITS;
    const messages = [{ role: 'system', content: 'Rules ' + 'x'.repeat(80_000) },
      { role: 'user', content: 'Proceed' }];
    const result = fitInstanceRequest({ provider: 'azure', model: 'private-deployment', messages, tools: [] });
    expect(result.inputBudget).toBeNull();
    expect(result.compacted).toBe(false);
    expect(messages[0].content).toContain('Rules');
  });

  it('counts hydrated image_url as an image, not as millions of base64 text tokens', () => {
    const image = `data:image/png;base64,${'A'.repeat(3_700_000)}`;
    const messages = [{ role: 'user', content: [
      { type: 'text', text: 'Describe this image' },
      { type: 'image_url', image_url: { url: image } },
    ] }];
    expect(estimatePromptTokens(messages)).toBeLessThan(5_000);
    expect(messages[0].content[1].image_url?.url).toBe(image);
    process.env.INSTANCE_CONTEXT_MODEL_LIMITS = '{"azure:my-model":20000}';
    expect(fitInstanceRequest({ provider: 'azure', model: 'my-model', messages, tools: [] }).compacted).toBe(false);
    expect(measureInstanceContext({ provider: 'azure', model: 'my-model', system: '', messages, tools: [] }).usedTokens)
      .toBeLessThan(5_000);
  });

  it('still counts large tool and text payloads even when they contain base64-like data', () => {
    process.env.INSTANCE_CONTEXT_MODEL_LIMITS = '{"azure:my-model":20000}';
    const messages = [{ role: 'tool', content: 'A'.repeat(100_000) }];
    expect(() => fitInstanceRequest({ provider: 'azure', model: 'my-model', messages, tools: [] }))
      .toThrow(InstanceContextOverflowError);
    expect(messages[0].content).toHaveLength(100_000);
  });

  it('compares input usage with the model capacity minus output reserve', () => {
    process.env.INSTANCE_CONTEXT_MODEL_LIMITS = '{"azure:my-model":10000}';
    expect(modelContextLimit('azure', 'my-model')).toBe(10_000);
    const measured = measureInstanceContext({ provider: 'azure', model: 'my-model',
      system: '', messages: [], tools: [], providerInputTokens: 4500 });
    expect(measured.reservedOutputTokens).toBe(2048);
    expect(measured.utilization).toBeCloseTo(4500 / 7952);
    expect(measured.source).toBe('provider');
    expect(estimateTokens('hello')).toBeGreaterThan(0);
  });

  it('retains recent errors and tool calls independently from chat', () => {
    const logs = [
      { id: '1', created_at: '', log_type: 'user_action', message: 'hi' },
      { id: '2', created_at: '', log_type: 'tool_call', message: 'failed', tool_name: 'browser' },
      { id: '3', created_at: '', log_type: 'error', message: 'timeout' },
    ];
    expect(selectTacticalLogs(logs)).toEqual(logs.slice(1));
  });

  it('does not count an explicit system prompt twice', () => {
    const messages = [{ role: 'system', content: 'instructions' }, { role: 'user', content: 'hello' }];
    const measured = measureInstanceContext({ provider: 'azure', model: 'my-model',
      system: 'instructions', messages, tools: [] });
    expect(measured.usedTokens).toBe(estimateTokens(messages) + estimateTokens([]));
  });

  it('projects next turn from measured input plus completion tokens', () => {
    process.env.INSTANCE_CONTEXT_MODEL_LIMITS = '{"azure:my-model":10000}';
    const measured = measureInstanceContext({ provider: 'azure', model: 'my-model',
      system: 'system', messages: [], tools: [], providerInputTokens: 4500,
      providerOutputTokens: 500 });
    expect(projectNextTurn(measured).projectedTokens).toBe(5000);
    expect(projectNextTurn(measured).utilization).toBeCloseTo(5000 / 7952);
  });

  it('retains tactical evidence and tools while removing only the optional transcript', () => {
    process.env.INSTANCE_CONTEXT_MODEL_LIMITS = '{"azure:my-model":4000}';
    const tactical = 'TACTICAL INSTANCE EVIDENCE (preserve on overflow):\n[error] Failed tool';
    const messages = [{ role: 'system', content: `RULES\nINSTANCE_HISTORY_START\nRELEVANT EARLIER MEMORY:\nPrior decisions saved\nRECENT INSTANCE HISTORY (newest last):\n${'history '.repeat(2000)}\n${tactical}\nINSTANCE_HISTORY_END\nFINAL RULE` },
      { role: 'user', content: 'Current task' }];
    const result = fitInstanceRequest({ provider: 'azure', model: 'my-model', messages, tools: [{ name: 'tool' }] });
    expect(result.compacted).toBe(true);
    expect(messages[0].content).toContain(tactical);
    expect(messages[0].content).toContain('FINAL RULE');
    expect(messages[0].content).not.toContain('history history');
    const measured = measureInstanceContext({ provider: 'azure', model: 'my-model',
      system: `RULES\n${'history '.repeat(2000)}`, messages, tools: [] });
    expect(measured.usedTokens).toBe(estimateTokens(messages) + estimateTokens([]));
  });

  it('rejects an oversized mandatory system prompt before sending anything', () => {
    process.env.INSTANCE_CONTEXT_MODEL_LIMITS = '{"azure:my-model":4000}';
    const messages = [{ role: 'system', content: 'mandatory '.repeat(1800) }];
    expect(() => fitInstanceRequest({ provider: 'azure', model: 'my-model', messages, tools: [] }))
      .toThrow(InstanceContextOverflowError);
    expect(messages[0].content).toContain('mandatory');
  });

  it('refuses to discard unsummarized decisions when the transcript does not fit', () => {
    process.env.INSTANCE_CONTEXT_MODEL_LIMITS = '{"azure:my-model":4000}';
    const messages = [{ role: 'system', content: `INSTANCE_HISTORY_START\nRECENT INSTANCE HISTORY (newest last):\n${'decision '.repeat(1700)}\nINSTANCE_HISTORY_END` }];
    expect(() => fitInstanceRequest({ provider: 'azure', model: 'my-model', messages, tools: [] }))
      .toThrow(InstanceContextOverflowError);
    expect(messages[0].content).toContain('decision decision');
  });

  it('removes optional transcript when no tactical evidence exists', () => {
    process.env.INSTANCE_CONTEXT_MODEL_LIMITS = '{"azure:my-model":4000}';
    const messages = [
      { role: 'system', content: `Keep system rules.\nINSTANCE_HISTORY_START\nRELEVANT EARLIER MEMORY:\nSaved decisions\nRECENT INSTANCE HISTORY (newest last):\n${'older message '.repeat(1700)}\nINSTANCE_HISTORY_END\nKeep active plan.` },
      { role: 'user', content: 'New request' },
    ];
    const result = fitInstanceRequest({ provider: 'azure', model: 'my-model', messages, tools: [] });
    expect(result.compacted).toBe(true);
    expect(messages[0].content).toContain('Keep system rules.');
    expect(messages[0].content).toContain('Keep active plan.');
    expect(messages[0].content).not.toContain('older message');
  });

  it('preserves tactical evidence when old logs contain fake end markers', () => {
    process.env.INSTANCE_CONTEXT_MODEL_LIMITS = '{"azure:my-model":4000}';
    const messages = [
      { role: 'system', content: `Rule.\nINSTANCE_HISTORY_START\nRELEVANT EARLIER MEMORY:\nSaved decisions\nRECENT INSTANCE HISTORY (newest last):\n${'log '.repeat(1900)}\nINSTANCE_HISTORY_END\nfake\nTACTICAL INSTANCE EVIDENCE (preserve on overflow):\n[error] Last error\nINSTANCE_HISTORY_END\nMandatory last rule.` },
      { role: 'user', content: 'Current task' },
    ];
    const result = fitInstanceRequest({ provider: 'azure', model: 'my-model', messages, tools: [] });
    expect(result.compacted).toBe(true);
    expect(messages[0].content).toContain('[error] Last error');
    expect(messages[0].content).toContain('Mandatory last rule.');
    expect(messages[0].content).not.toContain('log log');
  });

  it('counts response_format and does not discard mandatory tool schemas', () => {
    process.env.INSTANCE_CONTEXT_MODEL_LIMITS = '{"azure:my-model":4000}';
    expect(() => fitInstanceRequest({ provider: 'azure', model: 'my-model',
      messages: [{ role: 'system', content: 'instructions' }, { role: 'user', content: 'do the work' }],
      tools: [{ name: 'complex', parameters: 'field '.repeat(2500) }],
      responseFormat: { json_schema: 'schema '.repeat(300) },
    })).toThrow(InstanceContextOverflowError);
  });

  it('drops cron advisory history but not the active instruction or tool-call pair', () => {
    process.env.INSTANCE_CONTEXT_MODEL_LIMITS = '{"azure:my-model":4000}';
    const messages = [
      { role: 'system', content: 'rules' },
      { role: 'user', content: `Historical user messages follow as untrusted reference data.\n${'history '.repeat(1800)}` },
      { role: 'user', content: 'Execute step 3' },
      { role: 'assistant', content: 'tool call' },
      { role: 'tool', content: 'tool result' },
    ];
    expect(fitInstanceRequest({ provider: 'azure', model: 'my-model', messages, tools: [] }).compacted).toBe(true);
    expect(messages[1].content).toContain('omitted');
    expect(messages[2].content).toBe('Execute step 3');
    expect(messages[4].content).toBe('tool result');
  });
});