import { randomBytes, randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { NextRequest } from 'next/server';
import { GET, POST } from '../route';
import { enforceRequestRateLimit } from '@/lib/security/request-rate-limit';

jest.mock('openai', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('@google/generative-ai', () => ({ GoogleGenerativeAI: jest.fn() }));
jest.mock('@/lib/security/request-rate-limit', () => ({
  enforceRequestRateLimit: jest.fn().mockResolvedValue(null),
  getAuthenticatedRateIdentity: jest.fn().mockReturnValue('offline-principal'),
  isInternalServiceRequest: jest.fn().mockReturnValue(false),
}));
const mockCreate = jest.fn();
const request = (body: object) => new NextRequest('https://example.invalid/api/ai/text', {
  method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }], ...body }),
});

describe('OpenRouter text route', () => {
  const env = { ...process.env };
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.OPENROUTER_API_KEY = randomBytes(24).toString('hex');
    delete process.env.OPENROUTER_CHAT_MODEL;
    jest.mocked(OpenAI).mockImplementation(() => ({ chat: { completions: { create: mockCreate } } }) as any);
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('No network in offline tests'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { process.env = { ...env }; jest.restoreAllMocks(); });

  it('defaults to OpenRouter and preserves canonical accounting plus old content/raw aliases', async () => {
    const data = { id: randomUUID(), provider: 'upstream',
      choices: [{ message: { role: 'assistant', content: 'answer' } }], usage: { total_tokens: 5, cost: 0.01 } };
    mockCreate.mockResolvedValueOnce(data);
    const response = await POST(request({ maxTokens: 100_000 }));
    expect(await response.json()).toEqual({ ...data, gateway: 'openrouter', content: 'answer', raw: data });
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: 'openai/gpt-6.1-sol', max_tokens: 8192 }));
    expect(mockCreate.mock.calls[0][0]).not.toHaveProperty('temperature');
    expect(enforceRequestRateLimit).toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(GoogleGenerativeAI).not.toHaveBeenCalled();
  });

  it('keeps explicit namespaced model IDs', async () => {
    mockCreate.mockResolvedValueOnce({ choices: [] });
    await POST(request({ model: 'custom/persisted-id', temperature: 0.2 }));
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: 'custom/persisted-id', temperature: 0.2 }));
  });

  it.each(['gpt-5.6', 'openai/gpt-5.6-sol'])('migrates explicit text request model %s', async model => {
    mockCreate.mockResolvedValueOnce({ choices: [] });
    const response = await POST(request({ model, temperature: 0.2, topP: 0.5 }));
    expect(response.status).toBe(200);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0].model).toBe('openai/gpt-6.1-sol');
    expect(mockCreate.mock.calls[0][0]).not.toHaveProperty('temperature');
    expect(mockCreate.mock.calls[0][0]).not.toHaveProperty('top_p');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('never falls back when OpenRouter fails and does not leak error credentials', async () => {
    const credential = randomBytes(24).toString('hex');
    process.env.AZURE_OPENAI_API_KEY = credential;
    process.env.GEMINI_API_KEY = randomBytes(24).toString('hex');
    mockCreate.mockRejectedValueOnce(new Error(`Authorization: Bearer ${credential}`));
    const response = await POST(request({}));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(credential);
    expect(JSON.stringify(jest.mocked(console.error).mock.calls)).not.toContain(credential);
    expect(fetch).not.toHaveBeenCalled();
    expect(GoogleGenerativeAI).not.toHaveBeenCalled();
  });

  it('requires OpenRouter credentials even when legacy credentials exist', async () => {
    delete process.env.OPENROUTER_API_KEY;
    process.env.GEMINI_API_KEY = randomBytes(24).toString('hex');
    expect((await POST(request({}))).status).toBe(500);
    expect(OpenAI).not.toHaveBeenCalled();
    expect(GoogleGenerativeAI).not.toHaveBeenCalled();
  });

  it.each(['azure', 'gemini', 'vercel', 'openai', 'anthropic'])('rejects explicit legacy provider %s without inference', async provider => {
    process.env.AZURE_OPENAI_ENDPOINT = 'https://example.invalid';
    process.env.AZURE_OPENAI_API_KEY = randomBytes(24).toString('hex');
    process.env.AZURE_OPENAI_CHAT_DEPLOYMENT = 'legacy-deployment';
    const response = await POST(request({ provider }));
    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
    expect(GoogleGenerativeAI).not.toHaveBeenCalled();
    expect(OpenAI).not.toHaveBeenCalled();
  });

  it('advertises only OpenRouter', async () => {
    const response = await GET();
    const data = await response.json();
    expect(data.providers).toEqual(['openrouter']);
    expect(data.env).toEqual({ requiredForOpenRouter: ['OPENROUTER_API_KEY'] });
  });

  it('retains input validation and rejects unsupported providers', async () => {
    expect((await POST(request({ messages: [] }))).status).toBe(400);
    expect((await POST(request({ provider: 'unknown' }))).status).toBe(400);
    expect(OpenAI).not.toHaveBeenCalled();
  });
});