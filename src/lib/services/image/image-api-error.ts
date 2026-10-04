import { readResponseWithLimit } from '@/lib/security/limited-response';

// Only fixed, application-owned diagnostics may reach tool logs. Never forward
// arbitrary HTTP bodies, provider messages, credentials or authenticated URLs.
const CONFIGURATION_ERRORS = new Set([
  'Azure image generation is not configured',
  'Invalid Azure image endpoint configuration',
  'Invalid Azure image deployment or API version configuration',
]);

export async function imageApiError(response: Response): Promise<string> {
  const prefix = `Image API request failed (${response.status})`;
  if (response.status !== 503) return prefix;
  try {
    const payload = JSON.parse((await readResponseWithLimit(response, 16 * 1024)).toString('utf8'));
    if (typeof payload?.error === 'string' && CONFIGURATION_ERRORS.has(payload.error)) {
      return `${prefix}: ${payload.error}. Check Azure image endpoint, credentials, deployment and API version; Azure inference was not submitted`;
    }
    if (payload?.error?.code === 'RATE_LIMIT_UNAVAILABLE') {
      return `${prefix}: Image request admission is temporarily unavailable; Azure inference was not submitted`;
    }
  } catch {
    // Malformed, oversized or unreadable bodies must not obscure the HTTP status.
  }
  return prefix;
}