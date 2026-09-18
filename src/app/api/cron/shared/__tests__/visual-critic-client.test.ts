import OpenAI from 'openai';
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
      GEMINI_API_KEY: 'gemini-key',
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
    });

    expect(result.model).toBe('gemini-2.5-flash');
    expect(result.finishReason).toBe('stop');
    expect(result.responseFormat).toBe('json_schema');
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-2.5-flash',
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
});
