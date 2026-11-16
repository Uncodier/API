import { analyzeVideo, buildVideoAnalysisContent } from '../analyze-video';
import { parseVideoAnalysisInput, type ExtractedVideo } from '../contract';
import { withExtractedVideo } from '../media-extraction';
import { createOpenRouterClient } from '../../ai/openrouter';
import { getExecutionRouting } from '../../ai/customer-routing';
import { transcribeAudioBuffer } from '../../ai/transcribeAudio';
import { CreditService } from '../../billing/CreditService';
import { chargeOpenRouterUsage } from '../../billing/openrouter-usage-billing';

jest.mock('../media-extraction', () => ({ withExtractedVideo: jest.fn() }));
jest.mock('../../ai/openrouter', () => ({ createOpenRouterClient: jest.fn(), getOpenRouterChatModel: () => 'openai/gpt-6.1-sol' }));
jest.mock('../../ai/customer-routing', () => ({ getExecutionRouting: jest.fn(),
  withCustomerCapability: (_capability: string, operation: () => unknown) => operation() }));
jest.mock('../../ai/transcribeAudio', () => ({ transcribeAudioBuffer: jest.fn() }));
jest.mock('../../billing/CreditService', () => ({ CreditService: {
  validateCredits: jest.fn(), deductCredits: jest.fn(), PRICING: { AUDIO_TRANSCRIPTION: 0.1, FRAME_EXTRACTION: 0.1 },
} }));
jest.mock('../../billing/openrouter-usage-billing', () => ({ chargeOpenRouterUsage: jest.fn() }));
jest.mock('@/lib/status/text-execution-observation', () => ({ observeCompletedTextRequest: (_model: string, request: () => unknown) => request() }));

const create = jest.fn();
const scope = { siteId: 'authorized-site', instanceId: 'authorized-instance' };
const raw = { video_url: 'https://media.example.test/clip.mp4' };
let media: ExtractedVideo;

beforeEach(() => {
  jest.clearAllMocks();
  media = { duration_seconds: 40, width: 1920, height: 1080, has_audio: true,
    frames: [{ timestamp_seconds: 10, width: 768, height: 432, data_url: 'data:image/jpeg;base64,YQ==' }],
    frame_interval: { start_seconds: 0, end_seconds: 40 },
    transcription_interval: { start_seconds: 5, end_seconds: 15 }, audio: Buffer.from('synthetic wav') };
  jest.mocked(withExtractedVideo).mockImplementation(async (_input, callback) => callback(media));
  jest.mocked(createOpenRouterClient).mockReturnValue({ chat: { completions: { create } } } as any);
  jest.mocked(getExecutionRouting).mockReturnValue(undefined);
  jest.mocked(CreditService.validateCredits).mockResolvedValue(true);
  jest.mocked(CreditService.deductCredits).mockResolvedValue({ success: true });
  jest.mocked(transcribeAudioBuffer).mockResolvedValue({ success: true, text: 'Speech from the selected interval.' });
  jest.mocked(chargeOpenRouterUsage).mockResolvedValue(undefined);
  create.mockResolvedValue({ id: 'generation-test', model: 'openai/gpt-6.1-sol', usage: { cost: 0.01 },
    choices: [{ finish_reason: 'stop', message: { content: 'At 10s a person enters the room.' } }] });
});

it('describes sampled frames, bills nested inference, and does not expose raw frame data', async () => {
  const result = await analyzeVideo(raw, scope);
  expect(result.description).toContain('10s');
  expect(result.frames.samples).toEqual([{ timestamp_seconds: 10, width: 768, height: 432 }]);
  expect(JSON.stringify(result)).not.toContain('data:image');
  expect(transcribeAudioBuffer).not.toHaveBeenCalled();
  expect(create.mock.calls[0][0].messages[1].content).toEqual(expect.arrayContaining([
    { type: 'image_url', image_url: { url: media.frames[0].data_url, detail: 'low' } },
  ]));
  expect(chargeOpenRouterUsage).toHaveBeenCalledWith(expect.objectContaining({ siteId: scope.siteId, generationId: 'generation-test' }));
});

it('transcribes only the extracted audio and includes its source interval', async () => {
  media.frames = [];
  const result = await analyzeVideo({ ...raw, frames: { enabled: false },
    transcription: { enabled: true, start_seconds: 5, end_seconds: 15 } }, scope);
  expect(transcribeAudioBuffer).toHaveBeenCalledWith({ buffer: media.audio, contentType: 'audio/wav' });
  expect(result.transcription).toMatchObject({ status: 'completed', interval: { start_seconds: 5, end_seconds: 15 } });
  expect(create).not.toHaveBeenCalled();
  expect(chargeOpenRouterUsage).not.toHaveBeenCalled();
});

it('passes existing text and source-relative crop as reference data for a zoom', async () => {
  const input = parseVideoAnalysisInput({ ...raw, previous_description: 'Overview',
    frames: { crop: { x: 0, y: 0, width: 0.5, height: 0.5 } } });
  const content = buildVideoAnalysisContent(input, media, 'Speech');
  expect(content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Overview') });
  expect(content.at(-1)).toMatchObject({ image_url: { detail: 'high' } });
});

it('reports no audio without billing or fabricating speech', async () => {
  media.has_audio = false; media.audio = undefined; media.frames = [];
  const result = await analyzeVideo({ ...raw, frames: { enabled: false }, transcription: { enabled: true } }, scope);
  expect(result.transcription.status).toBe('no_audio');
  expect(CreditService.deductCredits).not.toHaveBeenCalled();
  expect(transcribeAudioBuffer).not.toHaveBeenCalled();
});

it('does not charge platform transcription credits for customer-owned routing', async () => {
  jest.mocked(getExecutionRouting).mockReturnValue({ payer: 'customer', siteId: scope.siteId } as any);
  await analyzeVideo({ ...raw, transcription: { enabled: true } }, scope);
  expect(CreditService.validateCredits).not.toHaveBeenCalled();
  expect(CreditService.deductCredits).not.toHaveBeenCalled();
  expect(createOpenRouterClient).toHaveBeenCalledWith({ timeout: 120000, maxRetries: 0 });
});

it('stops before transcription on unconfirmed deduction', async () => {
  jest.mocked(CreditService.deductCredits).mockResolvedValue({ success: false });
  await expect(analyzeVideo({ ...raw, transcription: { enabled: true } }, scope)).rejects.toThrow('not confirmed');
  expect(transcribeAudioBuffer).not.toHaveBeenCalled();
});

it('does not repeat inference after uncertain settlement', async () => {
  jest.mocked(chargeOpenRouterUsage).mockRejectedValue(new Error('Uncertain billing'));
  await expect(analyzeVideo(raw, scope)).rejects.toThrow('Uncertain billing');
  expect(create).toHaveBeenCalledTimes(1);
});

it('records unknown platform inference outcomes without replaying the request', async () => {
  create.mockRejectedValueOnce(new Error('Transport timeout'));
  await expect(analyzeVideo(raw, scope)).rejects.toThrow('Video description failed');
  expect(chargeOpenRouterUsage).toHaveBeenCalledWith(expect.objectContaining({
    usage: undefined, eventId: expect.any(String), siteId: scope.siteId,
  }));
  expect(create).toHaveBeenCalledTimes(1);
});

it('does not settle a confirmed pre-dispatch provider rejection', async () => {
  create.mockRejectedValueOnce({ status: 429 });
  await expect(analyzeVideo(raw, scope)).rejects.toThrow('Video description failed');
  expect(chargeOpenRouterUsage).not.toHaveBeenCalled();
});

it('does not describe missing frames or failed transcription', async () => {
  media.frames = [];
  await expect(analyzeVideo(raw, scope)).rejects.toThrow('No video frames');
  media.frames = [{ timestamp_seconds: 10, width: 100, height: 100, data_url: 'data:image/jpeg;base64,YQ==' }];
  jest.mocked(transcribeAudioBuffer).mockResolvedValue({ success: false, error: 'private-provider-error' });
  await expect(analyzeVideo({ ...raw, transcription: { enabled: true } }, scope)).rejects.toThrow('Video transcription failed');
  expect(create).not.toHaveBeenCalled();
});

it('rejects invalid input before downloads and incomplete provider output after settlement', async () => {
  await expect(analyzeVideo({ ...raw, frames: { count: 25 } }, scope)).rejects.toThrow('Invalid');
  expect(withExtractedVideo).not.toHaveBeenCalled();
  create.mockResolvedValue({ id: 'generation-test', usage: { cost: 0.01 },
    choices: [{ finish_reason: 'length', message: { content: 'Partial' } }] });
  await expect(analyzeVideo(raw, scope)).rejects.toThrow('incomplete');
  expect(chargeOpenRouterUsage).toHaveBeenCalledTimes(1);
});