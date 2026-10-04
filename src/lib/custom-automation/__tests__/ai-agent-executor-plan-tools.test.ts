import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { bashTool, computerTool, editTool } from 'scrapybara/tools';
import { z } from 'zod';
import { AIAgentExecutor } from '../ai-agent-executor';
import { adaptPlanTools } from '@/app/api/robots/plan/act/plan-tools';

describe('OpenRouter plan execution with real Scrapybara tool builders', () => {
  const env = process.env;
  beforeEach(() => {
    process.env = { NODE_ENV: 'test', OPENROUTER_API_KEY: randomBytes(24).toString('hex') };
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Offline only'));
    for (const method of ['log', 'warn', 'error'] as const) jest.spyOn(console, method).mockImplementation(() => {});
  });
  afterEach(() => { process.env = env; jest.restoreAllMocks(); });

  it('routes the plan through the OpenRouter executor with the validated SDK adapters', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/app/api/robots/plan/act/route.ts'), 'utf8');
    expect(source).toContain("new AIAgentExecutor({ provider: 'openrouter', siteId: effective_site_id })");
    expect(source).toContain('adaptPlanTools([');
    expect(source).toContain('tools: validatedTools');
    expect(source).toContain('preserveToolExecution: true');
    expect(source).not.toContain('client.act(');
    expect(source).not.toContain('scrapybara/anthropic');
  });

  it('preserves SDK parameter schemas, validation, defaults and execute closures', async () => {
    const remote = { computer: jest.fn().mockResolvedValue({ output: 'clicked' }),
      bash: jest.fn().mockResolvedValue({ output: 'done' }), edit: jest.fn().mockResolvedValue({ output: 'edited' }) };
    const originals = [computerTool(remote as any), bashTool(remote as any), editTool(remote as any)];
    const tools = adaptPlanTools(originals);
    expect(tools.map(tool => tool.name)).toEqual(['computer', 'bash', 'str_replace_editor']);
    tools.forEach((tool, index) => expect(tool.parameters).toBe(originals[index].parameters));
    await tools[0].execute({ action: 'click_mouse', button: 'left', coordinates: [12, 34], num_clicks: 2 });
    expect(remote.computer).toHaveBeenCalledWith(expect.objectContaining({ action: 'click_mouse', coordinates: [12, 34], numClicks: 2 }));
    await tools[1].execute({ command: 'pwd' });
    expect(remote.bash).toHaveBeenCalledWith(expect.objectContaining({ command: 'pwd', restart: false, listSessions: false }));
    await tools[2].execute({ command: 'create', path: '/tmp/offline', file_text: 'hello' });
    expect(remote.edit).toHaveBeenCalledWith(expect.objectContaining({ path: '/tmp/offline', fileText: 'hello' }));
    await expect(tools[0].execute({ action: 'not-a-real-action' })).rejects.toThrow();
    expect(remote.computer).toHaveBeenCalledTimes(1);
    expect(() => adaptPlanTools([{ name: 'missing-schema', execute: async () => null }])).toThrow('parameters');
  });

  it('executes SDK tools through OpenRouter and retains schema output, callbacks and usage', async () => {
    const remote = { bash: jest.fn().mockResolvedValue({ output: 'directory', error: '' }) };
    const executor = new AIAgentExecutor({ provider: 'openrouter', siteId: 'offline-site' });
    const output = { event: 'step_completed', step: 1, assistant_message: 'Done' };
    const create = jest.fn()
      .mockResolvedValueOnce({ id: 'first', choices: [{ message: { role: 'assistant', content: '', tool_calls: [
        { id: 'call-bash', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'pwd' }) } },
      ] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5, cost: 0.01 } })
      .mockResolvedValueOnce({ id: 'second', choices: [{ message: { role: 'assistant', content: JSON.stringify(output) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9, cost: 0.02 } });
    (executor as any).client.chat.completions.create = create;
    const onStep = jest.fn();
    const result = await executor.act({ tools: adaptPlanTools([bashTool(remote as any)]), prompt: 'Execute plan',
      schema: z.object({ event: z.string(), step: z.number(), assistant_message: z.string() }), onStep, maxIterations: 2 });
    expect(remote.bash).toHaveBeenCalledTimes(1);
    expect(result.output).toEqual(output);
    expect(result.usage).toMatchObject({ totalTokens: 14, cost: 0.03 });
    expect(onStep).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][0].tools[0].function.parameters.properties).toHaveProperty('command');
    expect(create.mock.calls[0][0].tools[0].function.parameters.properties).not.toHaveProperty('_dummy');
    expect(create.mock.calls[0][0]).toMatchObject({ user: 'offline-site' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('propagates the existing pause callback instead of continuing inference', async () => {
    const executor = new AIAgentExecutor();
    const create = jest.fn().mockResolvedValue({ choices: [{ message: { role: 'assistant', content: 'Paused' } }] });
    (executor as any).client.chat.completions.create = create;
    const pause = new Error('PLAN_PAUSED');
    await expect(executor.act({ tools: [], prompt: 'Plan', onStep: () => { throw pause; } })).rejects.toBe(pause);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('preserves remote wait execution and does not retry ambiguous SDK tool errors', async () => {
    const remote = { computer: jest.fn().mockResolvedValue({ output: 'remote wait' }) };
    const executor = new AIAgentExecutor();
    const create = jest.fn().mockResolvedValue({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [
      { id: 'wait', type: 'function', function: { name: 'computer', arguments: JSON.stringify({ action: 'wait', duration: 1 }) } },
    ] } }] });
    (executor as any).client.chat.completions.create = create;
    const options = { tools: adaptPlanTools([computerTool(remote as any)]), prompt: 'Wait',
      preserveToolExecution: true, maxIterations: 1 };
    await executor.act(options);
    expect(remote.computer).toHaveBeenCalledTimes(1);
    expect(remote.computer).toHaveBeenCalledWith(expect.objectContaining({ action: 'wait', duration: 1 }));
    // Isolate executor retries from the SDK's own configured retry policy.
    const execute = jest.fn().mockRejectedValue(new Error('socket timeout'));
    await executor.act({ ...options, tools: [{ name: 'computer', parameters: z.object({ action: z.string(), duration: z.number() }), execute }] });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});