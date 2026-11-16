import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtractedVideo, VideoAnalysisInput } from './contract';
import { VideoAnalysisError } from './contract';
import { downloadVideoSource } from './media-download';

export const MAX_DURATION_SECONDS = 7200;
export const MAX_INTERVAL_SECONDS = 600;
export const MAX_FRAME_DATA_BYTES = 6 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_FRAMES = 24;
const MAX_OUTPUT_DIMENSION = 1920;
const PROCESS_TIMEOUT_MS = 60_000;
const EXTRACTION_TIMEOUT_MS = 180_000;
// Exclude playlists/manifests and image demuxers that can reference other files.
const FORMAT_WHITELIST = 'mov,matroska,webm,avi,flv,mpeg,mpegts,ogg,asf';
const LOCAL_INPUT = ['-protocol_whitelist', 'file,pipe', '-format_whitelist', FORMAT_WHITELIST];

function runBinary(binary: string, args: string[], maxBuffer: number, timeout: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(binary, args, {
      shell: false, timeout, killSignal: 'SIGKILL', maxBuffer, encoding: 'buffer', windowsHide: true,
    }, (error, stdout) => {
      // Never propagate command arguments, decoder stderr, paths, or signed URLs.
      if (error) reject(new Error('Video processing failed, timed out, or exceeded its output limit'));
      else resolve(stdout);
    });
  });
}

export async function assertVideoBinariesAvailable(): Promise<void> {
  try {
    await Promise.all([
      runBinary(process.env.FFMPEG_PATH || 'ffmpeg', ['-version'], 64 * 1024, 5000),
      runBinary(process.env.FFPROBE_PATH || 'ffprobe', ['-version'], 64 * 1024, 5000),
    ]);
  } catch {
    throw new VideoAnalysisError('VIDEO_ANALYSIS_UNAVAILABLE', 'Video analysis requires available FFmpeg and ffprobe binaries');
  }
}

type Interval = { start_seconds: number; end_seconds: number };
export function resolveVideoInterval(start: number, end: number | undefined, duration: number): Interval {
  if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_DURATION_SECONDS
    || !Number.isFinite(start) || start < 0 || start >= duration) {
    throw new Error('Video interval start must be within the source duration');
  }
  const resolvedEnd = end === undefined ? Math.min(duration, start + MAX_INTERVAL_SECONDS) : end;
  if (!Number.isFinite(resolvedEnd) || resolvedEnd > duration || resolvedEnd <= start
    || resolvedEnd - start > MAX_INTERVAL_SECONDS) {
    throw new Error('Video interval end must be within the source duration and at most 600 seconds after start');
  }
  return { start_seconds: start, end_seconds: resolvedEnd };
}

export function midpointFrameTimestamps(interval: Interval, count: number): number[] {
  if (!Number.isInteger(count) || count < 1 || count > MAX_FRAMES) {
    throw new Error('Video frame count must be between 1 and 24');
  }
  // These are source-time sampling targets; the decoded frame is the first available frame at/after each seek.
  return Array.from({ length: count }, (_, i) => interval.start_seconds
    + (i + 0.5) * (interval.end_seconds - interval.start_seconds) / count);
}

export function videoFrameGeometry(width: number, height: number, frames: VideoAnalysisInput['frames']) {
  if (![frames.max_width, frames.max_height].every((n) => Number.isInteger(n)
    && n >= 64 && n <= MAX_OUTPUT_DIMENSION)) {
    throw new Error('Video frame dimensions must be between 64 and 1920');
  }
  const crop = frames.crop;
  if (crop && (![crop.x, crop.y, crop.width, crop.height].every(Number.isFinite)
    || crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0
    || crop.x + crop.width > 1 || crop.y + crop.height > 1)) {
    throw new Error('Video crop must be normalized within the source');
  }
  const x = crop ? Math.floor(crop.x * width) : 0;
  const y = crop ? Math.floor(crop.y * height) : 0;
  const cropWidth = crop ? Math.floor(crop.width * width) : width;
  const cropHeight = crop ? Math.floor(crop.height * height) : height;
  if (cropWidth < 1 || cropHeight < 1) throw new Error('Video crop is smaller than one source pixel');
  const ratio = Math.min(1, frames.max_width / cropWidth, frames.max_height / cropHeight);
  const outputWidth = Math.max(1, Math.floor(cropWidth * ratio));
  const outputHeight = Math.max(1, Math.floor(cropHeight * ratio));
  return {
    width: outputWidth, height: outputHeight,
    filter: `crop=${cropWidth}:${cropHeight}:${x}:${y}:exact=1,scale=${outputWidth}:${outputHeight},setsar=1`,
  };
}

export function parseVideoProbe(output: Buffer): { duration_seconds: number; width: number; height: number; has_audio: boolean } {
  let parsed: { format?: { duration?: string }; streams?: Array<{
    codec_type?: string; width?: number; height?: number; duration?: string;
    disposition?: { attached_pic?: number };
  }> };
  try { parsed = JSON.parse(output.toString('utf8')); }
  catch { throw new Error('Video metadata could not be read'); }
  if (!parsed || !Array.isArray(parsed.streams) || parsed.streams.length > 64) {
    throw new Error('Video source has invalid streams');
  }
  const video = parsed.streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const width = video?.width ?? 0;
  const height = video?.height ?? 0;
  const duration = Number(parsed.format?.duration ?? video?.duration);
  if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_DURATION_SECONDS
    || !Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0
    || width > 8192 || height > 8192 || width * height > 40_000_000) {
    throw new Error('Video source duration or dimensions exceed analysis limits');
  }
  return { duration_seconds: duration, width, height,
    has_audio: parsed.streams.some((s) => s.codec_type === 'audio') };
}

export async function withExtractedVideo<T>(
  input: VideoAnalysisInput,
  callback: (media: ExtractedVideo) => Promise<T>,
): Promise<T> {
  // Fail before any network I/O on hosts that cannot actually decode media.
  await assertVideoBinariesAvailable();
  const directory = await mkdtemp(join(tmpdir(), 'video-analysis-'));
  try {
    // Only preparation errors are safe to expose; callback/provider failures retain their own boundary.
    const prepare = async (): Promise<ExtractedVideo> => {
      const source = join(directory, 'source.video');
      await downloadVideoSource(input.video_url, source);
      const deadline = Date.now() + EXTRACTION_TIMEOUT_MS;
      const timeout = () => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('Video extraction timed out');
        return Math.min(PROCESS_TIMEOUT_MS, remaining);
      };
      const metadata = parseVideoProbe(await runBinary(process.env.FFPROBE_PATH || 'ffprobe', [
        '-v', 'error', ...LOCAL_INPUT, '-show_entries',
        'format=duration:stream=codec_type,width,height,duration:stream_disposition=attached_pic',
        '-of', 'json', source,
      ], 256 * 1024, timeout()));
      const media: ExtractedVideo = { ...metadata, frames: [] };
      // Validate both enabled intervals up front, even for a silent source.
      const frameInterval = input.frames.enabled
        ? resolveVideoInterval(input.frames.start_seconds, input.frames.end_seconds, metadata.duration_seconds) : undefined;
      const transcriptionInterval = input.transcription.enabled
        ? resolveVideoInterval(input.transcription.start_seconds, input.transcription.end_seconds, metadata.duration_seconds) : undefined;
      const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
      const common = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-max_alloc', '67108864'];
      if (frameInterval) {
        media.frame_interval = frameInterval;
        const geometry = videoFrameGeometry(metadata.width, metadata.height, input.frames);
        let totalBytes = 0;
        for (const timestamp of midpointFrameTimestamps(frameInterval, input.frames.count)) {
          const remainingBytes = MAX_FRAME_DATA_BYTES - totalBytes - 23;
          if (remainingBytes <= 0) throw new Error('Video frames exceed the 6 MiB output limit');
          const jpeg = await runBinary(ffmpeg, [
            ...common, ...LOCAL_INPUT, '-threads', '1', '-ss', String(timestamp), '-noautorotate', '-i', source,
            '-map', '0:V:0', '-an', '-sn', '-dn', '-frames:v', '1', '-vf', geometry.filter,
            '-threads', '1', '-c:v', 'mjpeg', '-pix_fmt', 'yuvj444p', '-q:v', '3', '-f', 'image2pipe', 'pipe:1',
          ], Math.floor(remainingBytes * 3 / 4), timeout());
          if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8
            || jpeg[jpeg.length - 2] !== 0xff || jpeg[jpeg.length - 1] !== 0xd9) {
            throw new Error('Video frame could not be extracted');
          }
          const dataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
          totalBytes += Buffer.byteLength(dataUrl);
          if (totalBytes > MAX_FRAME_DATA_BYTES) throw new Error('Video frames exceed the 6 MiB output limit');
          media.frames.push({ timestamp_seconds: timestamp, width: geometry.width, height: geometry.height, data_url: dataUrl });
        }
      }
      if (transcriptionInterval) {
        media.transcription_interval = transcriptionInterval;
        if (metadata.has_audio) {
          const audio = await runBinary(ffmpeg, [
            ...common, ...LOCAL_INPUT, '-threads', '1', '-ss', String(transcriptionInterval.start_seconds),
            '-i', source, '-t', String(transcriptionInterval.end_seconds - transcriptionInterval.start_seconds),
            '-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', '1', '-ar', '16000', '-threads', '1',
            '-c:a', 'pcm_s16le', '-f', 'wav', 'pipe:1',
          ], MAX_AUDIO_BYTES, timeout());
          if (audio.length > MAX_AUDIO_BYTES) throw new Error('Video audio exceeds the 25 MiB output limit');
          if (audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF'
            || audio.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Video audio could not be extracted');
          media.audio = audio;
        }
      }
      return media;
    };
    let media: ExtractedVideo;
    try { media = await prepare(); }
    catch (error) {
      if (error instanceof VideoAnalysisError) throw error;
      // All preparation errors are sanitized here, including underlying filesystem failures.
      throw new VideoAnalysisError('VIDEO_ANALYSIS_EXTRACTION_FAILED',
        'Video could not be extracted. Check the source host, duration, intervals, and media size limits.');
    }
    return await callback(media);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}