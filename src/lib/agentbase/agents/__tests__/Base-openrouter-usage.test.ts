import { Base } from '../Base';
import { AgentConnector } from '../AgentConnector';

class TestBase extends Base {
  async executeCommand(): Promise<any> { return { status: 'completed' }; }
  extract(response: any) { return this.extractTokenUsage(response); }
}
const base = new TestBase('test', 'test');
beforeEach(() => jest.spyOn(console, 'log').mockImplementation(() => {}));
afterEach(() => jest.restoreAllMocks());

it('keeps actual zero cost and generation identity without changing token pricing inputs', () => {
  const usage = { prompt_tokens: 0, input_tokens: 99, completion_tokens: 2, cost: 0,
    cost_details: { upstream_inference_cost: 0 }, is_byok: false };
  expect(base.extract({ id: 'gen-offline', modelInfo: { model: 'openai/example', provider: 'openrouter' }, usage }))
    .toEqual({ usage, inputTokens: 0, outputTokens: 2, cost: 0, cost_details: usage.cost_details,
      is_byok: false, generationId: 'gen-offline', provider: 'openrouter', model: 'openai/example' });
});

it('returns accounting metadata from AgentConnector rather than dropping Base extraction', async () => {
  const usage = { prompt_tokens: 2, completion_tokens: 3, cost: 0, is_byok: false };
  const connector = { callAgent: jest.fn().mockResolvedValue({ content: 'Done', usage, generationId: 'gen-offline',
    modelInfo: { provider: 'openrouter', model: 'openai/example' } }) };
  const agent = new AgentConnector('agent', 'agent', connector as any);
  const result = await agent.executeCommand({ id: 'command', task: 'Test', metadata: { stream: false } } as any);
  expect(result).toMatchObject({ status: 'completed', inputTokens: 2, outputTokens: 3, cost: 0, is_byok: false,
    usage, generationId: 'gen-offline', provider: 'openrouter', model: 'openai/example' });
});

it.each([
  [{ usage: { input_tokens: 2, output_tokens: 3 } }, 2, 3],
  [{ usage: { promptTokens: 2, completionTokens: 3 } }, 2, 3],
  [{ metadata: { usage: { prompt_tokens: 2, completion_tokens: 3 } } }, 2, 3],
  [{ content: { usage: { prompt_tokens: 2, completion_tokens: 3 } } }, 2, 3],
  [{ usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3 } }, 2, 3],
  [{ inputTokenCount: 2, outputTokenCount: 3 }, 2, 3],
  [{}, 0, 0],
])('supports token fallback without estimating provider cost: %j', (response, inputTokens, outputTokens) => {
  const result = base.extract(response);
  expect(result).toMatchObject({ inputTokens, outputTokens });
  expect(result).not.toHaveProperty('cost');
});