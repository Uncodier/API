import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AIAgentExecutor } from '../ai-agent-executor';
import { resolveAssistantHistoryModel } from '@/app/api/robots/instance/assistant/history-model';

describe('assistant history model matches execution', () => {
  const env = process.env;
  beforeEach(() => {
    process.env = { NODE_ENV: 'test', OPENROUTER_API_KEY: randomBytes(24).toString('hex'),
      AI_PROVIDER: 'azure', AI_MODEL: 'old-model', MICROSOFT_AZURE_OPENAI_DEPLOYMENT: 'private-deployment' };
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Offline only'));
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { process.env = env; jest.restoreAllMocks(); });

  it.each([undefined, 'google/gemini-3.1-pro-preview', 'gpt-4o'])('pins the actual OpenRouter model (%s)', configured => {
    if (configured) process.env.OPENROUTER_CHAT_MODEL = configured;
    const selection = resolveAssistantHistoryModel();
    const defaultExecutor = new AIAgentExecutor();
    expect(selection).toEqual({ provider: defaultExecutor.getProvider(), model: defaultExecutor.getModel() });
    process.env.OPENROUTER_CHAT_MODEL = 'another/model';
    const pinnedExecutor = new AIAgentExecutor(selection);
    expect(pinnedExecutor.getModel()).toBe(selection.model);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('uses the same resolved model in preparation history and serialized execution options', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/app/api/robots/instance/assistant/steps.ts'), 'utf8');
    expect(source).toContain('.buildHistory(message, finalProvider, finalModel)');
    expect(source).toContain('ai_model: finalModel');
    expect(source).not.toContain('process.env.AI_MODEL');
    expect(source).not.toContain('MICROSOFT_AZURE_OPENAI_DEPLOYMENT');
  });
});