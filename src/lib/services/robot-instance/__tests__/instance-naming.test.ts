import { generateInstanceName, compareObjectives } from '../instance-naming';
import { createOpenRouterClient } from '@/lib/services/ai/openrouter';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: {} }));
jest.mock('@/lib/services/ai/openrouter', () => ({
  ...jest.requireActual('@/lib/services/ai/openrouter'),
  createOpenRouterClient: jest.fn(),
}));

describe('instance naming through OpenRouter', () => {
  const create = jest.fn();
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(createOpenRouterClient).mockReturnValue({ chat: { completions: { create } } } as any);
  });
  it('uses Sol without unsupported temperature and generates a name', async () => {
    create.mockResolvedValue({ choices: [{ message: { content: 'Marketing Research Hub' } }] });
    expect(await generateInstanceName('Marketing research')).toBe('Marketing Research Hub');
    expect(create.mock.calls[0][0]).toEqual(expect.objectContaining({ model: 'openai/gpt-6.1-sol' }));
    expect(create.mock.calls[0][0]).not.toHaveProperty('temperature');
  });
  it('uses the same gateway for structured objective comparison', async () => {
    create.mockResolvedValue({ choices: [{ message: { content: '{"similar":true,"similarity":0.9}' } }] });
    expect(await compareObjectives('Marketing', 'Marketing research')).toEqual({ similar: true, similarity: 0.9 });
    expect(create.mock.calls[0][0]).toEqual(expect.objectContaining({
      model: 'openai/gpt-6.1-sol', response_format: { type: 'json_object' },
    }));
  });
  it('uses local naming fallback, not another paid account, when unconfigured', async () => {
    jest.mocked(createOpenRouterClient).mockImplementation(() => { throw new Error('Not configured'); });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await generateInstanceName('Marketing in Spanish')).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});