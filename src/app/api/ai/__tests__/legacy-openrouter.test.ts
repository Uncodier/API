import { randomBytes, randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import { NextRequest } from 'next/server';
import { POST } from '../route';
import { processConversation } from '../../conversation/route';
import { callApiWithMessage, handleIncompleteJsonResponse, prepareApiMessage } from '@/lib/utils/api-utils';
import { continueJsonGeneration, extractResponseContent, updateResponseContent } from '@/lib/services/continuation-service';
import { analyzeWithConversationApi } from '@/lib/services/conversation-client';

const mockCreate = jest.fn();
jest.mock('openai', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('@/lib/services/conversation-client', () => ({ analyzeWithConversationApi: jest.fn() }));
jest.mock('@/lib/utils/image-utils', () => ({ prepareImageForAPI: jest.fn(), captureScreenshot: jest.fn() }));
jest.mock('@/lib/utils/html-preprocessor', () => ({ preprocessHtml: jest.fn() }));
jest.mock('cheerio', () => ({}));

const envelope = (content: string) => ({ id: `gen-${randomUUID()}`, model: 'anthropic/custom-model',
  provider: 'upstream-provider', choices: [{ index: 0, message: { role: 'assistant', content } }],
  usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7, cost: 0.004 } });
const request = (body: object) => new NextRequest('https://example.invalid/api/ai', {
  method: 'POST', body: JSON.stringify(body),
});

describe('legacy AI OpenRouter contracts', () => {
  const env = { ...process.env };
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.OPENROUTER_API_KEY = randomBytes(24).toString('hex');
    delete process.env.OPENROUTER_CHAT_MODEL;
    jest.mocked(OpenAI).mockImplementation(() => ({ chat: { completions: { create: mockCreate } } }) as any);
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { process.env = { ...env }; jest.restoreAllMocks(); });

  it.each(['anthropic', 'openai', 'gemini'] as const)('repairs canonical choices for %s without losing accounting', async (modelType) => {
    const result = envelope('{"ok":true');
    mockCreate.mockResolvedValueOnce(result);
    const response = await POST(request({ messages: [{ role: 'user', content: 'JSON please' }], modelType }));
    const data = await response.json();
    expect(data.choices[0].message.content).toBe('{"ok":true}');
    expect(data).toMatchObject({ id: result.id, provider: result.provider, usage: result.usage });
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: 'openai/gpt-6.1-sol' }));
    expect(OpenAI).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: process.env.OPENROUTER_API_KEY, baseURL: 'https://openrouter.ai/api/v1', maxRetries: 0,
    }));
  });

  it('preserves explicit stale namespaced models and server helper uses only OpenRouter', async () => {
    mockCreate.mockResolvedValueOnce(envelope('text'));
    await callApiWithMessage([{ role: 'user', content: 'hello' }], 'gemini', 'legacy/persisted-model');
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: 'legacy/persisted-model' }));
    expect(prepareApiMessage('look', 'data:image/png;base64,AA==', 'system', 'anthropic')[1].content[1])
      .toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } });
  });

  it('fails closed with legacy credentials and never returns or logs upstream credentials', async () => {
    const credential = randomBytes(24).toString('hex');
    process.env.AZURE_OPENAI_API_KEY = credential;
    delete process.env.OPENROUTER_API_KEY;
    expect((await POST(request({ messages: [{ role: 'user', content: 'hi' }] }))).status).toBe(500);
    expect(OpenAI).not.toHaveBeenCalled();
    process.env.OPENROUTER_API_KEY = credential;
    mockCreate.mockRejectedValueOnce(new Error(`Authorization: Bearer ${credential}`));
    const response = await POST(request({ messages: [{ role: 'user', content: 'hi' }] }));
    expect(await response.text()).not.toContain(credential);
    expect(JSON.stringify(jest.mocked(console.error).mock.calls)).not.toContain(credential);
  });

  it('uses choices first even alongside historical native content', async () => {
    const response = { ...envelope('{"ok":1'), content: [{ text: 'native stale' }] };
    await handleIncompleteJsonResponse(response, [], 'anthropic');
    expect(extractResponseContent(response)).toBe('{"ok":1}');
    expect(response.content[0].text).toBe('native stale');
    const legacy = { candidates: [{ content: { parts: [{ text: 'old' }] } }] };
    updateResponseContent(legacy, 'new');
    expect(extractResponseContent(legacy)).toBe('new');
  });

  it('continues a choices envelope while retaining generation cost', async () => {
    const response = envelope('"value"}');
    jest.mocked(analyzeWithConversationApi).mockResolvedValueOnce(response);
    const result = await continueJsonGeneration({ incompleteJson: '{"key":', modelType: 'gemini',
      modelId: 'google/custom', siteUrl: '', maxRetries: 1 });
    expect(result.success).toBe(true);
    expect(result.completeJson).toEqual({ key: 'value' });
    expect(result.generations).toEqual([{ id: response.id, model: response.model,
      provider: response.provider, usage: response.usage }]);
    expect(jest.mocked(analyzeWithConversationApi).mock.calls[0][7]).toBe(false);
  });

  it('keeps conversation choices and assistant history for non-OpenAI vendors', async () => {
    const conversationId = randomUUID();
    const response = envelope('{"ok":true');
    mockCreate.mockResolvedValueOnce(response).mockResolvedValueOnce(envelope('follow-up'));
    const result = await processConversation({ messages: [{ role: 'user', content: 'JSON' }],
      modelType: 'anthropic', modelId: 'anthropic/custom', responseFormat: 'json', conversationId });
    expect(result).toMatchObject({ id: response.id, usage: response.usage, provider: response.provider,
      _requestMetadata: { closed: true } });
    await processConversation({ messages: [{ role: 'user', content: 'next' }], modelType: 'anthropic', conversationId });
    expect(mockCreate.mock.calls[1][0].messages).toContainEqual({ role: 'assistant', content: '{"ok":true}' });
    expect(mockCreate.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('joins automatic continuation suffixes and preserves both billable generation IDs', async () => {
    const first = envelope('{"key":');
    const second = envelope('"value"}');
    mockCreate.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const result = await processConversation({ messages: [{ role: 'user', content: 'JSON' }],
      modelType: 'gemini', modelId: 'google/custom', responseFormat: 'json', conversationId: randomUUID() });
    expect(result.choices[0].message.content).toBe('{"key":"value"}');
    expect(result.id).toBe(second.id);
    expect(result.continuation_generations[0]).toMatchObject({ id: first.id, usage: first.usage });
    expect(result._requestMetadata.closed).toBe(true);
  });
});