import { analyzeVideoTool } from '../assistantProtocol';
import { analyzeVideo } from '@/lib/services/video-analysis/analyze-video';
import { VideoAnalysisError } from '@/lib/services/video-analysis/contract';

jest.mock('@/lib/services/video-analysis/analyze-video', () => ({ analyzeVideo: jest.fn() }));

beforeEach(() => jest.clearAllMocks());

it('exposes interval, frame resolution, transcription and zoom controls, not tenant identifiers', () => {
  const tool = analyzeVideoTool('site', 'instance');
  expect(tool.name).toBe('analyze_video');
  const schema = tool.parameters as any;
  expect(schema.properties.frames.properties).toEqual(expect.objectContaining({
    start_seconds: expect.any(Object), end_seconds: expect.any(Object), count: expect.any(Object),
    max_width: expect.any(Object), max_height: expect.any(Object), crop: expect.any(Object),
  }));
  expect(schema.properties.transcription.properties.enabled).toBeDefined();
  expect(schema.properties.previous_description).toBeDefined();
  expect(schema.properties.site_id).toBeUndefined();
});

it('binds authorized identity in the host closure', async () => {
  jest.mocked(analyzeVideo).mockResolvedValue({ success: true } as any);
  const args = { video_url: 'https://media.example.test/clip.mp4' };
  await analyzeVideoTool('site', 'instance').execute(args);
  expect(analyzeVideo).toHaveBeenCalledWith(args, { siteId: 'site', instanceId: 'instance' });
});

it('exposes only fixed safe extraction/validation errors', async () => {
  jest.mocked(analyzeVideo).mockRejectedValue(new VideoAnalysisError('VIDEO_ANALYSIS_INVALID_INPUT', 'Invalid interval'));
  expect(await analyzeVideoTool('site', 'instance').execute({})).toEqual({
    success: false, code: 'VIDEO_ANALYSIS_INVALID_INPUT', error: 'Invalid interval',
  });
});

it('accepts shared router metadata without forwarding it into strict media validation', async () => {
  jest.mocked(analyzeVideo).mockResolvedValue({ success: true } as any);
  const video_url = 'https://media.example.test/clip.mp4';
  await analyzeVideoTool('site', 'instance').execute({ video_url, thought_process: 'Inspect the clip' });
  expect(analyzeVideo).toHaveBeenCalledWith({ video_url }, { siteId: 'site', instanceId: 'instance' });
});

it('does not leak provider details or automatically retry uncertain paid work', async () => {
  const sensitive = `synthetic-private-provider-${Date.now()}`;
  jest.mocked(analyzeVideo).mockRejectedValue(new Error(sensitive));
  const result = await analyzeVideoTool('site', 'instance').execute({});
  expect(JSON.stringify(result)).not.toContain(sensitive);
  expect(result).toMatchObject({ success: false, code: 'VIDEO_ANALYSIS_FAILED' });
  expect(analyzeVideo).toHaveBeenCalledTimes(1);
});