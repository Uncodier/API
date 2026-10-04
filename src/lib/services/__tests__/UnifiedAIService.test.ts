import { UnifiedAIService } from '../UnifiedAIService';

describe('UnifiedAIService gateway selection', () => {
  const originalFetch = global.fetch;
  const fetchMock = jest.fn();
  beforeEach(() => { fetchMock.mockReset(); global.fetch = fetchMock; });
  afterAll(() => { global.fetch = originalFetch; });

  it('uses OpenRouter by default for text and keeps usage metadata', async () => {
    const result = { content: 'Hello', usage: { cost: 0.01 }, id: 'generation-test' };
    fetchMock.mockResolvedValue(new Response(JSON.stringify(result)));
    expect(await UnifiedAIService.generateText({ messages: [{ role: 'user', content: 'Hello' }] })).toEqual(result);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).provider).toBe('openrouter');
  });

  it('does not try another provider/account when Azure image generation fails', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'Quota exceeded' }), { status: 429 }));
    await expect(UnifiedAIService.generateImage({ prompt: 'A tree', site_id: 'site' })).rejects.toThrow('Quota exceeded');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).provider).toBe('azure');
  });

  it('defaults images to Azure while retaining deployment, size, quality and references', async () => {
    const result = { provider: 'azure', images: [{ url: 'https://storage.example.test/image.png' }], metadata: { model: 'image-deployment' } };
    const options = {
      prompt: 'A tree', site_id: 'site', instance_id: 'instance', model: 'image-deployment',
      size: '2048x1024', quality: 'high', ratio: '3:2', aspect_ratio: '16:9',
      reference_images: ['https://storage.example.test/reference.png'],
    } as const;
    fetchMock.mockResolvedValue(new Response(JSON.stringify(result)));
    expect(await UnifiedAIService.generateImage({ ...options, reference_images: [...options.reference_images] })).toEqual(result);
    expect(fetchMock).toHaveBeenCalledWith('/api/ai/image', expect.objectContaining({ body: JSON.stringify({ ...options, provider: 'azure' }) }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['auto', 'low', 'medium', 'high', 'xhigh', 'max', 'standard', 'hd'] as const)('forwards explicit Azure image quality %s unchanged', async quality => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ provider: 'azure', images: [] })));
    await UnifiedAIService.generateImage({ prompt: 'Tree', site_id: 'site', provider: 'azure', size: 'auto', quality });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ provider: 'azure', size: 'auto', quality });
  });

  it('defers TTS selection to the server without forcing Vercel', async () => {
    fetchMock.mockResolvedValue(new Response(new Uint8Array([1, 2])));
    expect(await UnifiedAIService.synthesizeAudio({ text: 'Hola' })).toEqual(new Uint8Array([1, 2]).buffer);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ text: 'Hola' });
  });

  it('keeps an explicit provider and model rather than silently substituting Pro', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ videos: [] })));
    await UnifiedAIService.generateVideo({ prompt: 'A tree', site_id: 'site', provider: 'openrouter', model: 'openai/sora-2' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe('openai/sora-2');
  });

  it('resumes an existing video without a second billable submit', async () => {
    const pending = { job_id: 'job-test', status: 'pending', videos: [], error: 'Submission outcome uncertain' };
    fetchMock.mockResolvedValue(new Response(JSON.stringify(pending), { status: 202 }));
    expect(await UnifiedAIService.generateVideo({ prompt: 'A tree', site_id: 'site', job_id: 'job-test' })).toEqual(pending);
    expect(fetchMock).toHaveBeenCalledWith('/api/ai/video?site_id=site&job_id=job-test', expect.objectContaining({ method: 'GET', body: undefined }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['azure', 'gemini', 'vercel'])('rejects legacy gateway %s without a request', async provider => {
    await expect(UnifiedAIService.synthesizeAudio({ text: 'Hola', provider: provider as any })).rejects.toThrow('Only OpenRouter');
    await expect(UnifiedAIService.generateText({ messages: [], provider: provider as any })).rejects.toThrow('Only OpenRouter');
    await expect(UnifiedAIService.generateVideo({ prompt: 'Tree', site_id: 'site', provider: provider as any })).rejects.toThrow('Only OpenRouter');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['openrouter', 'gemini', 'vercel'])('rejects non-Azure image provider %s without a request or alias', async provider => {
    await expect(UnifiedAIService.generateImage({ prompt: 'Tree', site_id: 'site', provider: provider as any })).rejects.toThrow('Only Azure');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});