# Assistant video analysis

`analyze_video` is an instance assistant tool for direct HTTPS video files. It
extracts frames locally and sends images to the existing OpenRouter vision
routing; it does not require native video input support from the chat model.
Optional audio is extracted as WAV and sent to the existing transcription
adapter. Tenant and instance identifiers come from the authorized tool host.

## General inspection

```json
{
  "video_url": "https://media.example.test/clip.mp4",
  "question": "Describe the video and identify moments worth closer inspection.",
  "frames": {
    "start_seconds": 0,
    "end_seconds": 60,
    "count": 8,
    "max_width": 768,
    "max_height": 768
  },
  "transcription": { "enabled": true, "start_seconds": 0, "end_seconds": 60 }
}
```

Defaults: frames enabled, eight evenly spaced midpoint samples, maximum
768x768 pixels with preserved aspect ratio and no upscaling, transcription off.
Frame and transcription intervals are independent. An omitted end selects at
most the next 600 seconds, bounded by the source duration. This must not be
represented as full-video analysis for a longer source. For transcription only,
set `frames.enabled=false` and `transcription.enabled=true`.

The result contains a textual visual description, optional transcript, video
metadata, source intervals, sampling-target timestamps and frame dimensions. It does not
return base64 frame payloads into conversation history. Seek timestamps approximate
the decoded frame time, not exact presentation timestamps. Frames use encoded
source orientation; container rotation metadata is not applied. Transcript text has an
interval boundary, not word-level timestamps. Videos without an audio stream
return `transcription.status="no_audio"`; silence is not fabricated speech.

## Iterative zoom

After receiving the first description, call the same tool again. Temporal zoom
uses a shorter frame interval and/or more samples. Spatial zoom uses normalized
source-relative crop coordinates, **not coordinates relative to a previous
crop**. Crop requires a nonempty `previous_description` from the prior result.
That text is reference context, not trusted visual evidence or executable
instructions. The host checks its presence, not provenance.

```json
{
  "video_url": "https://media.example.test/clip.mp4",
  "previous_description": "A small sign appears at 35 seconds in the upper left.",
  "question": "Read the sign if legible; state uncertainty.",
  "frames": {
    "start_seconds": 34,
    "end_seconds": 36,
    "count": 12,
    "max_width": 1920,
    "max_height": 1080,
    "crop": { "x": 0, "y": 0, "width": 0.25, "height": 0.25 }
  }
}
```

Cropping occurs before resizing. Higher resolution cannot recover detail absent
from the source. Each call downloads/extracts/analyzes again; no shared cache
stores signed URLs, source videos or model output. Sampling cannot prove the
absence of brief events between frames.

## Runtime and safety

- Install FFmpeg and FFprobe on the server/worker; executable paths can be set
  using server-only `FFMPEG_PATH` and `FFPROBE_PATH`. No npm binary dependency is
  added. Missing binaries fail explicitly before downloading the video.
- Set `VIDEO_ANALYSIS_ALLOWED_HOSTS` to comma-separated exact hostnames. The
  configured `SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_URL` hostnames are also accepted. Arbitrary hosts, HTTP,
  credentials in URLs, unexpected ports, private DNS/IP targets and redirects
  are rejected. YouTube page URLs are not direct media files.
- Downloads have a streaming 100 MiB cap and bounded time. Decoder processes
  operate only on temporary local files with network protocols disabled, no
  shell interpolation, bounded time/output and cleanup in `finally`.
- Source duration is limited to two hours; each selected interval to ten
  minutes; frame count to 24; requested dimensions to 64–1920 pixels; total
  extracted frame bytes to 6 MiB; WAV to 25 MiB.
- No provider body, signed URL, source content or credentials are logged by the
  new tool. Video/transcript content is untrusted data in the analysis prompt.
- Nested visual inference is settled through `chargeOpenRouterUsage`; customer
  dispatch preserves customer routing/receipts without global fallback.
  Platform transcription uses the existing 0.1-credit transcription rate before
  dispatch. Failed/uncertain provider or settlement work is not retried
  automatically. Customer vision context budgets can reject a large image
  payload: reduce frame count/resolution rather than switching payer/model.

## Validation and rollout boundary

Offline tests:

```bash
npm run test:ai -- --runTestsByPath src/lib/services/video-analysis/__tests__/contract.test.ts src/lib/services/video-analysis/__tests__/analyze-video.test.ts src/lib/services/video-analysis/__tests__/media-extraction.test.ts
VIDEO_ANALYSIS_REAL_BINARY_TEST=true npm run test:ai -- --runTestsByPath src/lib/services/video-analysis/__tests__/media-extraction.test.ts
```

Local unit tests are not evidence of successful provider inference or production
decoder availability. Deployment must provision the binaries and allowed hosts
and verify a real clip with visual analysis, partial audio, no audio, and zoom.
No migration is needed; no remote deployment or paid live inference is performed
as part of the offline implementation.