import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, copyFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { request } from 'node:https';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { lookup } from 'node:dns/promises';
import { assertSafeRemoteUrl } from '../../../security/safe-remote-url';
import { downloadVideoSource, allowedVideoHosts, validateVideoSourceUrl,
  resolvePinnedVideoAddress, samePinnedAddress } from '../media-download';
import { midpointFrameTimestamps, parseVideoProbe, resolveVideoInterval,
  videoFrameGeometry, withExtractedVideo } from '../media-extraction';
import type { VideoAnalysisInput } from '../contract';

jest.mock('node:child_process', () => ({ execFile: jest.fn() }));
jest.mock('node:dns/promises', () => ({ lookup: jest.fn() }));
jest.mock('node:https', () => ({ request: jest.fn() }));
jest.mock('../../../security/safe-remote-url', () => ({ assertSafeRemoteUrl: jest.fn() }));
jest.mock('../media-download', () => ({
  ...jest.requireActual('../media-download'), downloadVideoSource: jest.fn(),
}));

const input = (): VideoAnalysisInput => ({
  video_url: 'https://media.example.invalid/video.mp4',
  frames: { enabled: true, count: 2, max_width: 768, max_height: 768, start_seconds: 0 },
  transcription: { enabled: true, start_seconds: 0 },
});
const probe = (audio = true) => Buffer.from(JSON.stringify({
  format: { duration: '100' },
  streams: [{ codec_type: 'video', width: 1920, height: 1080 }, ...(audio ? [{ codec_type: 'audio' }] : [])],
}));
const jpeg = Buffer.from([0xff, 0xd8, 0x01, 0xff, 0xd9]);
const wav = Buffer.alloc(44);
wav.write('RIFF', 0); wav.write('WAVE', 8);

function fakeBinaries(audio = true) {
  (execFile as unknown as jest.Mock).mockImplementation((_binary, args, _options, callback) => {
    const output = args.includes('-version') ? Buffer.from('version')
      : args.includes('-show_entries') ? probe(audio) : args.includes('mjpeg') ? jpeg : wav;
    callback(null, output, Buffer.alloc(0));
    return { kill: jest.fn() };
  });
}

beforeEach(() => {
  jest.resetAllMocks();
  fakeBinaries();
  jest.mocked(downloadVideoSource).mockResolvedValue(undefined);
  jest.mocked(assertSafeRemoteUrl).mockImplementation(async value => new URL(value));
});

describe('video extraction geometry and intervals', () => {
  test('defaults omitted end to source duration or a 600-second window', () => {
    expect(resolveVideoInterval(5, undefined, 100)).toEqual({ start_seconds: 5, end_seconds: 100 });
    expect(resolveVideoInterval(5, undefined, 1000)).toEqual({ start_seconds: 5, end_seconds: 605 });
    expect(midpointFrameTimestamps({ start_seconds: 10, end_seconds: 30 }, 4)).toEqual([12.5, 17.5, 22.5, 27.5]);
  });
  test.each([[100, undefined], [0, 101], [5, 5], [-1, 20], [0, NaN]])(
    'rejects invalid endpoints without clamping (%s,%s)', (start, end) => {
      expect(() => resolveVideoInterval(start as number, end, 100)).toThrow();
    });
  test('rejects intervals longer than 600 seconds and invalid frame counts', () => {
    expect(() => resolveVideoInterval(0, 601, 1000)).toThrow();
    for (const count of [0, 25, 1.5]) expect(() => midpointFrameTimestamps({ start_seconds: 0, end_seconds: 1 }, count)).toThrow();
  });
  test('crops in source coordinates then scales without upscaling', () => {
    const selection = { ...input().frames, crop: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } };
    expect(videoFrameGeometry(1920, 1080, selection)).toEqual({
      width: 768, height: 432, filter: 'crop=960:540:480:270:exact=1,scale=768:432,setsar=1',
    });
    expect(videoFrameGeometry(100, 50, input().frames).width).toBe(100);
    expect(() => videoFrameGeometry(100, 50, { ...selection, crop: { x: 0.9, y: 0, width: 0.5, height: 1 } })).toThrow();
  });
  test('rejects malformed metadata, excessive source dimensions, and durations', () => {
    expect(() => parseVideoProbe(Buffer.from('bad'))).toThrow();
    for (const duration of ['7201', '0', 'NaN']) {
      expect(() => parseVideoProbe(Buffer.from(JSON.stringify({ format: { duration }, streams: [
        { codec_type: 'video', width: 1920, height: 1080 },
      ] })))).toThrow();
    }
    expect(parseVideoProbe(probe(false)).has_audio).toBe(false);
  });
});

describe('bounded subprocess extraction and cleanup', () => {
  test('checks binaries before download, produces JPEG frames and mono WAV, and cleans temp directory', async () => {
    let directory = '';
    const result = await withExtractedVideo(input(), async media => {
      directory = dirname(jest.mocked(downloadVideoSource).mock.calls[0][1]);
      expect(await readdir(directory)).toEqual([]);
      expect(media.frames.map(frame => frame.timestamp_seconds)).toEqual([25, 75]);
      expect(media.frames[0]).toMatchObject({ width: 768, height: 432, data_url: `data:image/jpeg;base64,${jpeg.toString('base64')}` });
      expect(media.audio).toEqual(wav);
      return 'done';
    });
    expect(result).toBe('done');
    await expect(access(directory)).rejects.toThrow();
    expect((execFile as unknown as jest.Mock).mock.invocationCallOrder[1]).toBeLessThan(jest.mocked(downloadVideoSource).mock.invocationCallOrder[0]);
    const commands = (execFile as unknown as jest.Mock).mock.calls;
    for (const [, args, options] of commands.slice(2)) {
      expect(args).toEqual(expect.arrayContaining(['-protocol_whitelist', 'file,pipe', '-format_whitelist']));
      expect(args).not.toContain(input().video_url);
      expect(options).toMatchObject({ shell: false, killSignal: 'SIGKILL', encoding: 'buffer' });
      expect(options.timeout).toBeLessThanOrEqual(60_000);
      expect(options.maxBuffer).toBeLessThanOrEqual(25 * 1024 * 1024);
    }
    expect(commands.at(-1)![1]).toEqual(expect.arrayContaining(['-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le']));
  });
  test('silent sources do not trigger transcription extraction or errors', async () => {
    fakeBinaries(false);
    await withExtractedVideo(input(), async media => {
      expect(media.has_audio).toBe(false);
      expect(media.audio).toBeUndefined();
      expect(media.transcription_interval).toEqual({ start_seconds: 0, end_seconds: 100 });
    });
    expect((execFile as unknown as jest.Mock).mock.calls.some(([, args]) => args.includes('pcm_s16le'))).toBe(false);
  });
  test('out-of-duration endpoints reject even with no audio', async () => {
    fakeBinaries(false);
    const selection = input(); selection.transcription.end_seconds = 101;
    await expect(withExtractedVideo(selection, jest.fn())).rejects.toThrow('duration, intervals');
  });
  test('binary errors are sanitized and do not start download', async () => {
    const secret = randomBytes(24).toString('hex');
    (execFile as unknown as jest.Mock).mockImplementation((_binary, _args, _options, callback) => {
      callback(new Error(secret), Buffer.alloc(0), Buffer.from(secret));
    });
    const error = await withExtractedVideo(input(), jest.fn()).catch(error => error) as Error;
    expect(error.message).toContain('FFmpeg');
    expect(error.message).not.toContain(secret);
    expect(downloadVideoSource).not.toHaveBeenCalled();
  });
  test('callback failures still clean temporary files', async () => {
    await expect(withExtractedVideo(input(), async () => { throw new Error('callback failure'); })).rejects.toThrow('callback failure');
    await expect(access(dirname(jest.mocked(downloadVideoSource).mock.calls[0][1]))).rejects.toThrow();
  });
  test('aggregate base64 frame limit is enforced', async () => {
    const huge = Buffer.alloc(3 * 1024 * 1024); huge[0] = 0xff; huge[1] = 0xd8;
    huge[huge.length - 2] = 0xff; huge[huge.length - 1] = 0xd9;
    (execFile as unknown as jest.Mock).mockImplementation((_binary, args, _options, callback) => {
      callback(null, args.includes('-version') ? Buffer.from('version') : args.includes('-show_entries') ? probe() : huge, Buffer.alloc(0));
    });
    await expect(withExtractedVideo(input(), jest.fn())).rejects.toThrow('media size limits');
  });
});

describe('video download target security', () => {
  const hosts = new Set(['media.example.invalid']);
  test('explicit hosts and Supabase hostname are permitted without wildcard expansion', () => {
    expect(allowedVideoHosts({ VIDEO_ANALYSIS_ALLOWED_HOSTS: 'media.example.invalid', SUPABASE_URL: 'https://storage.example.invalid' }))
      .toEqual(new Set(['media.example.invalid', 'storage.example.invalid']));
    expect(validateVideoSourceUrl(input().video_url, hosts).hostname).toBe('media.example.invalid');
    expect(() => allowedVideoHosts({ VIDEO_ANALYSIS_ALLOWED_HOSTS: '*.example.invalid' })).toThrow();
  });
  test.each(['http://media.example.invalid/video', 'https://other.example.invalid/video',
    'https://media.example.invalid:444/video', 'https://media.example.invalid/video#fragment'])('rejects unsafe URL %s', value => {
    expect(() => validateVideoSourceUrl(value, hosts)).toThrow();
  });
  test('rejects runtime-generated credentials without leaking values', () => {
    const url = new URL(input().video_url); url.password = randomBytes(16).toString('hex');
    expect(() => validateVideoSourceUrl(url.toString(), hosts)).toThrow('Video URL is not allowed');
  });
  test('validates the exact resolved addresses before pinning and fails closed on rebinding', async () => {
    jest.mocked(lookup).mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as never);
    await expect(resolvePinnedVideoAddress(new URL(input().video_url))).resolves.toEqual({ address: '8.8.8.8', family: 4 });
    expect(assertSafeRemoteUrl).toHaveBeenCalledWith('https://8.8.8.8/');
    jest.mocked(lookup).mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as never);
    jest.mocked(assertSafeRemoteUrl).mockImplementation(async value => {
      if (value.includes('127.0.0.1')) throw new Error('private address');
      return new URL(value);
    });
    await expect(resolvePinnedVideoAddress(new URL(input().video_url))).rejects.toThrow('not safe');
    expect(samePinnedAddress('::ffff:8.8.8.8', '8.8.8.8')).toBe(true);
    expect(samePinnedAddress('127.0.0.1', '8.8.8.8')).toBe(false);
  });
});

describe('HTTPS streaming downloader', () => {
  const actualDownload = jest.requireActual('../media-download').downloadVideoSource as typeof downloadVideoSource;
  const priorHosts = process.env.VIDEO_ANALYSIS_ALLOWED_HOSTS;
  afterEach(() => {
    if (priorHosts === undefined) delete process.env.VIDEO_ANALYSIS_ALLOWED_HOSTS;
    else process.env.VIDEO_ANALYSIS_ALLOWED_HOSTS = priorHosts;
    jest.useRealTimers();
  });
  function fakeRequest(status = 200, address = '8.8.8.8', headers = {}, chunks = [Buffer.from('video')]) {
    const req = Object.assign(new EventEmitter(), { destroy: jest.fn(), setTimeout: jest.fn(), end: jest.fn() });
    jest.mocked(request).mockImplementation(((_url: URL, _options: unknown, callback: (response: unknown) => void) => {
      req.end.mockImplementation(() => {
        const response = Object.assign(new PassThrough(), { statusCode: status, headers, socket: { remoteAddress: address } });
        callback(response);
        if (!response.destroyed) { for (const chunk of chunks) response.write(chunk); response.end(); }
      });
      return req;
    }) as never);
    return req;
  }
  beforeEach(() => {
    process.env.VIDEO_ANALYSIS_ALLOWED_HOSTS = 'media.example.invalid';
    jest.mocked(lookup).mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as never);
  });
  test('pins request lookup, preserves hostname TLS validation, and streams to a private file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'video-download-test-'));
    try {
      fakeRequest();
      await actualDownload(input().video_url, join(directory, 'source'));
      expect(await readFile(join(directory, 'source'), 'utf8')).toBe('video');
      const [url, options] = jest.mocked(request).mock.calls[0] as unknown as [URL, {
        lookup: (hostname: string, options: object, callback: jest.Mock) => void; agent: boolean;
      }];
      expect(url.hostname).toBe('media.example.invalid');
      expect(options.agent).toBe(false);
      const callback = jest.fn(); options.lookup(url.hostname, {}, callback);
      expect(callback).toHaveBeenCalledWith(null, '8.8.8.8', 4);
      expect(options).not.toHaveProperty('rejectUnauthorized', false);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  test.each([
    [302, '8.8.8.8', {}, 'redirects'],
    [200, '127.0.0.1', {}, 'verified DNS'],
    [200, '8.8.8.8', { 'content-length': String(101 * 1024 * 1024) }, 'size limit'],
    [200, '8.8.8.8', { 'content-encoding': 'gzip' }, 'rejected'],
  ])('rejects status/address/size/encoding before writing (%s,%s)', async (status, address, headers, message) => {
    fakeRequest(status as number, address as string, headers);
    await expect(actualDownload(input().video_url, join(tmpdir(), 'not-created-video-source'))).rejects.toThrow(message as string);
    expect(request).toHaveBeenCalledTimes(1);
  });
  test('enforces the streaming size cap even without content-length', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'video-download-test-'));
    try {
      fakeRequest(200, '8.8.8.8', {}, [Buffer.alloc(100 * 1024 * 1024 + 1)]);
      await expect(actualDownload(input().video_url, join(directory, 'source'))).rejects.toThrow('size limit');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  test('enforces a wall-clock download timeout', async () => {
    jest.useFakeTimers();
    const req = fakeRequest(); req.end.mockImplementation(() => undefined);
    const operation = actualDownload(input().video_url, join(tmpdir(), 'not-created-video-source'));
    const assertion = expect(operation).rejects.toThrow('timed out');
    await jest.advanceTimersByTimeAsync(60_000);
    await assertion;
    expect(req.destroy).toHaveBeenCalled();
  });
});

// Opt-in offline integration: requires installed binaries, creates only synthetic media.
const realBinaryTest = process.env.VIDEO_ANALYSIS_REAL_BINARY_TEST === 'true' ? test : test.skip;
realBinaryTest('real FFmpeg decodes cropped midpoint frames, partial WAV, and silent source with cleanup', async () => {
  const realExecFile = jest.requireActual('node:child_process').execFile as typeof execFile;
  const directory = await mkdtemp(join(tmpdir(), 'video-synthetic-test-'));
  const generate = (args: string[]) => new Promise<void>((resolve, reject) => {
    realExecFile(process.env.FFMPEG_PATH || 'ffmpeg', args, { timeout: 15_000 }, error => error ? reject(error) : resolve());
  });
  try {
    const fixture = join(directory, 'fixture.mp4');
    await generate(['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=10',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000', '-t', '4', '-c:v', 'mpeg4', '-c:a', 'aac', fixture]);
    (execFile as unknown as jest.Mock).mockImplementation(realExecFile);
    jest.mocked(downloadVideoSource).mockImplementation(async (_url, destination) => { await copyFile(fixture, destination); });
    const selection = input();
    selection.frames = { enabled: true, count: 2, max_width: 100, max_height: 100,
      start_seconds: 1, end_seconds: 3, crop: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } };
    selection.transcription = { enabled: true, start_seconds: 1, end_seconds: 2 };
    let extractionDirectory = '';
    await withExtractedVideo(selection, async media => {
      extractionDirectory = dirname(jest.mocked(downloadVideoSource).mock.calls[0][1]);
      expect(media.duration_seconds).toBeCloseTo(4);
      expect(media.frames.map(frame => frame.timestamp_seconds)).toEqual([1.5, 2.5]);
      expect(media.frames[0]).toMatchObject({ width: 100, height: 56 });
      expect(Buffer.from(media.frames[0].data_url.split(',')[1], 'base64').subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
      expect(media.audio!.length).toBeGreaterThanOrEqual(32000);
      expect(media.audio!.length).toBeLessThan(32500);
      expect(media.audio!.readUInt16LE(22)).toBe(1);
      expect(media.audio!.readUInt32LE(24)).toBe(16000);
    });
    await expect(access(extractionDirectory)).rejects.toThrow();
    const silent = join(directory, 'silent.mp4');
    await generate(['-hide_banner', '-loglevel', 'error', '-i', fixture, '-an', '-c:v', 'copy', silent]);
    jest.mocked(downloadVideoSource).mockImplementation(async (_url, destination) => { await copyFile(silent, destination); });
    await withExtractedVideo(selection, async media => {
      expect(media.has_audio).toBe(false); expect(media.audio).toBeUndefined(); expect(media.frames).toHaveLength(2);
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30_000);