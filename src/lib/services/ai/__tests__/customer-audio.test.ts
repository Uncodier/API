import { randomBytes } from 'node:crypto';
import { synthesizeSpeech } from '../tts-service';
import { transcribeAudioBuffer } from '../transcribeAudio';
import { getExecutionRouting, resolveCustomerDispatch } from '../customer-routing';
import { beginCustomerInference, recordCustomerInference } from '../../billing/customer-inference-receipts';
import { validateCustomerMp3 } from '../customer-audio';

jest.mock('../customer-routing', () => ({ ...jest.requireActual('../customer-routing'),
  getExecutionRouting: jest.fn(), resolveCustomerDispatch: jest.fn() }));
jest.mock('../../billing/customer-inference-receipts', () => ({ ...jest.requireActual('../../billing/customer-inference-receipts'),
  beginCustomerInference: jest.fn(async input => input.eventId), recordCustomerInference: jest.fn() }));
jest.mock('@/lib/status/telemetry', () => ({ recordTelemetry: jest.fn() }));

describe('customer speech and transcription actual adapters', () => {
  const originalFetch = global.fetch;
  const key = randomBytes(24).toString('hex');
  const routing = { payer: 'customer' as const, siteId: 'site', connectionId: 'connection', policyVersion: 1, credentialVersion: 1 };
  const frame = () => { const value = Buffer.alloc(417); value.set([255, 251, 144, 0]); return value; };
  beforeEach(() => {
    jest.clearAllMocks(); global.fetch = jest.fn();
    jest.mocked(getExecutionRouting).mockReturnValue(routing);
    jest.mocked(resolveCustomerDispatch).mockResolvedValue({ apiKey: key, modelId: 'vendor/speech', contextLength: null });
    jest.mocked(beginCustomerInference).mockImplementation(async input => input.eventId!);
    jest.mocked(recordCustomerInference).mockResolvedValue();
  });
  afterAll(() => { global.fetch = originalFetch; });
  it('uses dedicated speech endpoint with customer key, selected model and complete MP3', async () => {
    jest.mocked(global.fetch).mockResolvedValue(new Response(new Uint8Array(frame()), { headers: {
      'Content-Type': 'audio/mpeg', 'X-Generation-Id': 'generation-1' } }));
    const result = await synthesizeSpeech({ text: 'Test', voice: 'voice-1', operationId: 'speech-1' });
    expect(result.audio).toEqual(frame()); expect(result.provider).toBe('openrouter');
    const [url, request] = jest.mocked(global.fetch).mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/v1/audio/speech');
    expect(JSON.parse(request!.body as string)).toEqual({ model: 'vendor/speech', input: 'Test', voice: 'voice-1', response_format: 'mp3' });
    expect(request).toMatchObject({ redirect: 'error', headers: { Authorization: `Bearer ${key}` } });
    expect(beginCustomerInference).toHaveBeenCalledWith(expect.objectContaining({ operationKey: 'speech-1' }));
    expect(recordCustomerInference).toHaveBeenCalledWith(expect.objectContaining({ capability: 'speech', generationId: 'generation-1' }));
    expect(JSON.stringify(result)).not.toContain(key);
  });
  it.each([Buffer.from('ID3'), Buffer.from('{"error":"bad"}'), Buffer.from([255,251,144,0])])('rejects fake and truncated audio even with audio MIME', async bytes => {
    jest.mocked(global.fetch).mockResolvedValue(new Response(new Uint8Array(bytes), { headers: { 'Content-Type': 'audio/mpeg' } }));
    await expect(synthesizeSpeech({ text: 'Test' })).rejects.toThrow('do not replay');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(recordCustomerInference).toHaveBeenCalledWith(expect.objectContaining({ uncertain: true }));
  });
  it('rejects odd/incomplete PCM samples', async () => {
    jest.mocked(global.fetch).mockResolvedValue(new Response(new Uint8Array([0,1,2]), { headers: { 'Content-Type': 'audio/pcm' } }));
    await expect(synthesizeSpeech({ text: 'Test', format: 'pcm' })).rejects.toThrow('do not replay');
  });
  it('does not dispatch when durable claim fails', async () => {
    jest.mocked(beginCustomerInference).mockRejectedValue(new Error('claim failed'));
    await expect(synthesizeSpeech({ text: 'Test' })).rejects.toThrow('claim failed');
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it('validates whole MP3 frame length', () => {
    expect(() => validateCustomerMp3(frame())).not.toThrow();
    expect(() => validateCustomerMp3(frame().subarray(0,416))).toThrow('Truncated');
  });
  it('routes STT through documented JSON protocol without Azure config or billing', async () => {
    jest.mocked(global.fetch).mockResolvedValue(Response.json({ id: 'stt-1', text: 'hello', usage: { cost: 0.01 } }));
    const result = await transcribeAudioBuffer({ buffer: frame(), contentType: 'audio/mpeg' });
    expect(result).toMatchObject({ success: true, provider: 'openrouter', text: 'hello' });
    const [url, request] = jest.mocked(global.fetch).mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/v1/audio/transcriptions');
    expect(JSON.parse(request!.body as string)).toMatchObject({ model: 'vendor/speech', input_audio: { format: 'mp3', data: frame().toString('base64') } });
  });
  it('does not release speech when receipt fails and never retries', async () => {
    jest.mocked(global.fetch).mockResolvedValue(new Response(new Uint8Array(frame()), { headers: { 'Content-Type': 'audio/mpeg' } }));
    jest.mocked(recordCustomerInference).mockRejectedValue(new Error('receipt failed'));
    await expect(synthesizeSpeech({ text: 'Test' })).rejects.toThrow('receipt failed');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});