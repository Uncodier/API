import { readResponseWithLimit } from '@/lib/security/limited-response';

// Exact application-owned messages only. Provider bodies can contain credentials
// and authenticated URLs; neither arbitrary text nor partial matches are safe.
const LOCAL_ERRORS = new Set([
  'Unsupported video provider',
  'Gemini Omni video duration_seconds must be a whole second from 3 to 15',
  'Gemini Omni video supports at most 6 reference image URLs',
  'Gemini references cannot be combined with explicit frames',
  'Gemini Omni last frame requires a first frame and at most 10 seconds',
  'Gemini video aspect_ratio must be 16:9 or 9:16',
  'Gemini video resolution must be 720p or 1080p',
  'Use resolution and model instead of legacy video quality',
  'Video provider must match authorized routing: Gemini for platform, OpenRouter for customer BYOK only',
  'Gemini video generation is not configured',
  'Gemini video is not configured: set GEMINI_API_KEY',
  'Selected Gemini video model is not supported by this integration',
  'Video input image must be a public HTTPS URL',
  'Video input images must be PNG or JPEG',
  'Video input image is empty',
  'Video input image download failed or exceeded the size limit',
  'Customer OpenRouter routing is unavailable; platform fallback is prohibited',
  'prompt must contain between 1 and 10000 characters',
  'site_id must be a valid UUID',
  'site_id and job_id must be UUIDs',
  'Site access denied',
  'Instance does not belong to the authorized site',
  'reference_images must contain at most 3 URLs',
  'Invalid reference image URL',
  'first_frame_url must be a valid URL',
  'last_frame_url must be a valid URL',
  'Video job is busy or unavailable; retry status only',
  'Video status unavailable; retry status only',
]);

export async function readVideoApiError(response: Response): Promise<{ error: string; job_id?: string }> {
  const fallback = `Video API request failed (${response.status}); retry status only if a job_id exists`;
  try {
    const payload = JSON.parse((await readResponseWithLimit(response, 16 * 1024)).toString('utf8'));
    const job_id = typeof payload?.job_id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.job_id)
      ? payload.job_id : undefined;
    return { error: LOCAL_ERRORS.has(payload?.error) ? `Video API request failed (${response.status}): ${payload.error}` : fallback, job_id };
  } catch {
    return { error: fallback };
  }
}