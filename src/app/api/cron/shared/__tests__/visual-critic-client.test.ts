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
      choices: [{ message: { content: '{"pass":true,"defects":[]}' } }],
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
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-2.5-flash',
        max_tokens: 1_200,
      }),
      { signal: controller.signal },
    );
  });
});
