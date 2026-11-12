import { randomUUID } from 'node:crypto';
import { readResponseWithLimit } from '@/lib/security/limited-response';
import { beginCustomerInference, CustomerReceiptError, recordCustomerInference } from '../billing/customer-inference-receipts';
import { CustomerRoutingError, getExecutionRouting, resolveCustomerDispatch } from './customer-routing';
import type { SpeechOptions } from './tts-service';

/** Validate whole MPEG layer III frames, not just a misleading MIME or ID3 prefix. */
export function validateCustomerMp3(audio: Buffer): void {
  let offset = 0;
  if (audio.subarray(0, 3).toString() === 'ID3') {
    if (audio.length < 10 || [...audio.subarray(6, 10)].some(byte => byte > 127)) throw new Error('Invalid ID3');
    offset = 10 + ((audio[6] << 21) | (audio[7] << 14) | (audio[8] << 7) | audio[9]);
    if (audio[5] & 16) offset += 10;
  }
  let frames = 0;
  while (offset < audio.length) {
    if (audio.length - offset === 128 && audio.subarray(offset, offset + 3).toString() === 'TAG') break;
    const a = audio[offset], b = audio[offset + 1], c = audio[offset + 2];
    if (a !== 255 || (b & 224) !== 224 || ((b >> 1) & 3) !== 1) throw new Error('Invalid MP3 frame');
    const version = (b >> 3) & 3, bitrateIndex = c >> 4, rateIndex = (c >> 2) & 3;
    if (version === 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) throw new Error('Invalid MP3 rate');
    const rates = version === 3 ? [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320]
      : [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160];
    const rate = [44100,48000,32000][rateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4);
    const length = Math.floor((version === 3 ? 144 : 72) * rates[bitrateIndex] * 1000 / rate) + ((c >> 1) & 1);
    if (length < 4 || offset + length > audio.length) throw new Error('Truncated MP3');
    offset += length; frames++;
  }
  if (!frames) throw new Error('Empty MP3');
}

export function validateCustomerSpeech(options: SpeechOptions) {
  const format = options.format ?? 'mp3';
  if (typeof options.text !== 'string' || !options.text.trim() || options.text.length > 4096
      || !['mp3', 'pcm'].includes(format)
      || (options.provider !== undefined && options.provider !== 'openrouter')
      || (options.voice !== undefined && !/^[\w .:-]{1,100}$/.test(options.voice))
      || (options.speed !== undefined && (!Number.isFinite(options.speed) || options.speed < 0.25 || options.speed > 4))) {
    throw new CustomerRoutingError('INVALID_CUSTOMER_SPEECH_OPTIONS');
  }
  return format as 'mp3' | 'pcm';
}

export async function synthesizeCustomerSpeech(options: SpeechOptions) {
  const format = validateCustomerSpeech(options);
  const routing = getExecutionRouting();
  if (routing?.payer !== 'customer') throw new CustomerRoutingError('CUSTOMER_ROUTE_REQUIRED');
  const selected = await resolveCustomerDispatch(routing, 'speech');
  if (options.model && options.model !== selected.modelId) throw new CustomerRoutingError('CUSTOMER_MODEL_BINDING_MISMATCH');
  const eventId = await beginCustomerInference({ routing, capability: 'speech', eventId: randomUUID(),
    operationKey: options.operationId, requestedModel: selected.modelId });
  let generationId: string | undefined; let audio: Buffer;
  try {
    const response = await fetch('https://openrouter.ai/api/v1/audio/speech', {
      method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(120_000),
      headers: { Authorization: `Bearer ${selected.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: selected.modelId, input: options.text, response_format: format,
        ...(options.voice && options.voice !== 'auto' ? { voice: options.voice } : {}),
        ...(options.speed !== undefined ? { speed: options.speed } : {}) }),
    });
    generationId = response.headers.get('x-generation-id') ?? undefined;
    if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== (format === 'mp3' ? 'audio/mpeg' : 'audio/pcm')) throw new Error();
    audio = await readResponseWithLimit(response, 32 * 1024 * 1024);
    if (format === 'mp3') validateCustomerMp3(audio);
    else if (audio.length < 2 || audio.length % 2 !== 0) throw new Error('Incomplete PCM sample');
  } catch {
    await recordCustomerInference({ routing, capability: 'speech', eventId, generationId, requestedModel: selected.modelId, uncertain: true });
    throw new CustomerReceiptError();
  }
  await recordCustomerInference({ routing, capability: 'speech', eventId, generationId, requestedModel: selected.modelId });
  return { audio, provider: 'openrouter' as const, format, mimeType: format === 'mp3' ? 'audio/mpeg' : 'audio/pcm',
    generationId, receiptEventId: eventId, ...(options.language ? { language: options.language } : {}) };
}

export async function transcribeCustomerAudio(buffer: Buffer, mimeType: string, operationId?: string) {
  const formats: Record<string, string> = { 'audio/mp3': 'mp3', 'audio/mpeg': 'mp3', 'audio/wav': 'wav',
    'audio/flac': 'flac', 'audio/m4a': 'm4a', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/webm': 'webm', 'audio/aac': 'aac' };
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > 25 * 1024 * 1024 || !formats[mimeType]) {
    throw new CustomerRoutingError('INVALID_CUSTOMER_TRANSCRIPTION_AUDIO');
  }
  const { customerMediaJson } = await import('./customer-media-transport');
  return customerMediaJson({ capability: 'transcription', operationKey: operationId, body: {
    input_audio: { data: buffer.toString('base64'), format: formats[mimeType] }, response_format: 'json',
  }, validate(data, model) {
    if (typeof data.text !== 'string' || !data.text.trim() || data.text.length > 1_000_000) throw new Error('Invalid transcript');
    return { success: true, text: data.text.trim(), model, provider: 'openrouter', usage: data.usage, generationId: data.id };
  } });
}