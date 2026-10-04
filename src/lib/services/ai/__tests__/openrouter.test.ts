import { randomBytes } from 'node:crypto';
import OpenAI from 'openai';
import {
  createOpenRouterClient,
  getOpenRouterChatModel,
  isOpenRouterReasoningModel,
  OPENROUTER_BASE_URL,
  resolveOpenRouterModel,
} from '../openrouter';

jest.mock('openai', () => ({ __esModule: true, default: jest.fn() }));

describe('OpenRouter configuration', () => {
  beforeEach(() => jest.clearAllMocks());

  it('uses only OpenRouter credentials and a fixed trusted endpoint', () => {
    const key = randomBytes(24).toString('hex');
    createOpenRouterClient({ env: {
      OPENROUTER_API_KEY: key,
      OPENROUTER_APP_URL: 'https://example.invalid',
      OPENROUTER_APP_NAME: 'Offline test',
    } });
    expect(OpenAI).toHaveBeenCalledWith({
      apiKey: key, baseURL: OPENROUTER_BASE_URL, timeout: 240_000, maxRetries: 0,
      defaultHeaders: { 'HTTP-Referer': 'https://example.invalid', 'X-OpenRouter-Title': 'Offline test' },
    });
  });

  it('does not fall back to platform credentials when an explicit key is empty', () => {
    const key = randomBytes(24).toString('hex');
    expect(() => createOpenRouterClient({ apiKey: '', env: { OPENROUTER_API_KEY: key } }))
      .toThrow('OpenRouter is not configured');
    expect(OpenAI).not.toHaveBeenCalled();
  });

  it('does not reuse legacy Portkey or raw provider keys', () => {
    const key = randomBytes(24).toString('hex');
    expect(() => createOpenRouterClient({ env: {
      PORTKEY_API_KEY: key, OPENAI_API_KEY: key, AZURE_OPENAI_API_KEY: key,
    } })).toThrow('OPENROUTER_API_KEY');
    expect(OpenAI).not.toHaveBeenCalled();
  });

  it('creates independent clients for explicit server-resolved user credentials', () => {
    const first = randomBytes(24).toString('hex');
    const second = randomBytes(24).toString('hex');
    createOpenRouterClient({ apiKey: first });
    createOpenRouterClient({ apiKey: second });
    expect(jest.mocked(OpenAI).mock.calls.map(([options]) => options?.apiKey)).toEqual([first, second]);
  });

  it.each([
    ['gpt-6.1-sol', 'openai/gpt-6.1-sol'],
    ['gemini-3.1-pro-preview', 'google/gemini-3.1-pro-preview'],
    ['claude-sonnet-4', 'anthropic/claude-sonnet-4'],
    ['text-embedding-3-small', 'openai/text-embedding-3-small'],
    ['openai/sora-2', 'openai/sora-2'],
    ['vendor/custom-model', 'vendor/custom-model'],
  ])('qualifies %s without substituting the model', (input, expected) => {
    expect(resolveOpenRouterModel(input)).toBe(expected);
  });

  it('defaults to Sol and handles namespaced reasoning models', () => {
    expect(getOpenRouterChatModel({})).toBe('openai/gpt-6.1-sol');
    expect(getOpenRouterChatModel({ OPENROUTER_CHAT_MODEL: 'openai/gpt-6.1-sol-pro' }))
      .toBe('openai/gpt-6.1-sol-pro');
    expect(isOpenRouterReasoningModel('openai/gpt-6.1-sol')).toBe(true);
    expect(isOpenRouterReasoningModel('openai/gpt-4o')).toBe(false);
  });
});