import OpenAI from 'openai';
import { randomBytes } from 'node:crypto';
import { requestVisualCriticCompletion } from '../visual-critic-client';

jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn(),
}));

const ORIGINAL_ENV = { ...process.env };
const mockedOpenAI = OpenAI as unknown as jest.Mock;

describe('visual critic client', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...ORIGINAL_ENV,
      AI_PROVIDER: 'gemini',
      OPENROUTER_API_KEY: randomBytes(24).toString('hex'),
    };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('passes the abort signal to the provider request', async () => {
    const create = jest.fn().mockResolvedValue({
      model: 'gemini-2.5-flash',
      choices: [{
        finish_reason: 'stop',
        message: {
          content: '{"pass":true,"summary":"Looks good.","defects":[]}',
        },
      }],
    });
    mockedOpenAI.mockImplementation(() => ({
      chat: { completions: { create } },
    }));
    const controller = new AbortController();

    const result = await requestVisualCriticCompletion({
      model: 'gemini-2.5-flash',
      system: 'Return JSON.',
      content: [{ type: 'text', text: 'Review this.' }],
      signal: controller.signal,
      siteId: 'site-visual',
    });

    expect(result.model).toBe('gemini-2.5-flash');
    expect(result.finishReason).toBe('stop');
    expect(result.responseFormat).toBe('json_schema');
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'google/gemini-2.5-flash',
        user: 'site-visual',
        max_tokens: 1_200,
        response_format: expect.objectContaining({
          type: 'json_schema',
          json_schema: expect.objectContaining({
            name: 'visual_critic_verdict',
            strict: true,
          }),
        }),
      }),
      { signal: controller.signal },
    );
    expect(mockedOpenAI).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: 'https://openrouter.ai/api/v1',
      maxRetries: 0,
    }));
  });

  it('raises the output budget only when requested for a truncated retry', async () => {
    const create = jest.fn().mockResolvedValue({
      model: 'gemini-2.5-flash',
      choices: [{ finish_reason: 'stop', message: { content: '{"pass":true,"summary":"OK","defects":[]}' } }],
    });
    mockedOpenAI.mockImplementation(() => ({ chat: { completions: { create } } }));

    await requestVisualCriticCompletion({
      model: 'gemini-2.5-flash', system: 'Return JSON.', content: [],
      signal: new AbortController().signal, maxOutputTokens: 2_400,
    });

    expect(create.mock.calls[0][0].max_tokens).toBe(2_400);
  });

  it('falls back to JSON mode only when strict schemas are unsupported', async () => {
    const unsupported = Object.assign(
      new Error('response_format json_schema is unsupported'),
      { status: 400 },
    );
    const create = jest.fn()
      .mockRejectedValueOnce(unsupported)
      .mockResolvedValueOnce({
        model: 'gemini-2.5-flash',
        choices: [{
          finish_reason: 'stop',
          message: {
            content: '{"pass":true,"summary":"Looks good.","defects":[]}',
          },
        }],
      });
    mockedOpenAI.mockImplementation(() => ({
      chat: { completions: { create } },
    }));

    const result = await requestVisualCriticCompletion({
      model: 'gemini-2.5-flash',
      system: 'Return JSON.',
      content: [{ type: 'text', text: 'Review this.' }],
      signal: new AbortController().signal,
    });

    expect(result.responseFormat).toBe('json_object');
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][0]).toEqual(expect.objectContaining({
      response_format: { type: 'json_object' },
    }));
  });

  it('omits sampling for namespaced reasoning models and preserves gateway cost', async () => {
    const create = jest.fn().mockResolvedValue({ model: 'openai/gpt-6.1-sol', choices: [{ message: { content: '{}' } }], usage: { cost: 0.02, total_tokens: 20 } });
    mockedOpenAI.mockImplementation(() => ({ chat: { completions: { create } } }));
    const result = await requestVisualCriticCompletion({ model: 'openai/gpt-6.1-sol', system: 'JSON', content: [], signal: new AbortController().signal });
    expect(create.mock.calls[0][0]).not.toHaveProperty('temperature');
    expect(create.mock.calls[0][0].max_tokens).toBe(8_192);
    expect(result.usage).toEqual({ cost: 0.02, total_tokens: 20 });
  });

  it('does not fall back to a different account or vendor on authentication failure', async () => {
    const failure = Object.assign(new Error('Unauthorized'), { status: 401 });
    const create = jest.fn().mockRejectedValue(failure);
    mockedOpenAI.mockImplementation(() => ({ chat: { completions: { create } } }));
    await expect(requestVisualCriticCompletion({ model: 'openai/gpt-6.1-sol', system: 'JSON', content: [], signal: new AbortController().signal })).rejects.toBe(failure);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
