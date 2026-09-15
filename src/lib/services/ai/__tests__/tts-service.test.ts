import { synthesizeWithVercel } from '../tts-service';

describe('synthesizeWithVercel', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.restoreAllMocks();
    process.env = {
      ...originalEnv,
      VERCEL_AI_GATEWAY: 'https://ai-gateway.vercel.sh/v1',
      VERCEL_AI_GATEWAY_API_KEY: 'test-key',
    };
    delete process.env.VERCEL_AI_GATEWAY_OPENAI;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('uses the Vercel speech endpoint and decodes base64 audio', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ audio: Buffer.from('mp3-data').toString('base64') }),
    } as Response);

    const audio = await synthesizeWithVercel('Hello', 'alloy', 'mp3', 'tts-1');

    expect(audio).toEqual(Buffer.from('mp3-data'));
    expect(fetchMock).toHaveBeenCalledWith(
      'https://ai-gateway.vercel.sh/v4/ai/speech-model',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-key',
          'ai-gateway-protocol-version': '0.0.1',
          'ai-speech-model-specification-version': '4',
          'ai-model-id': 'openai/tts-1',
        }),
        body: JSON.stringify({
          text: 'Hello',
          voice: 'alloy',
          outputFormat: 'mp3',
        }),
      })
    );
  });

  it('throws when the gateway does not return audio', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as Response);

    await expect(synthesizeWithVercel('Hello')).rejects.toThrow(
      'Vercel Gateway TTS did not return base64 audio data'
    );
  });
});
