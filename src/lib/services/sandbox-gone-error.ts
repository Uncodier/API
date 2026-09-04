/**
 * Detects Vercel Sandbox API errors where the microVM is already stopped or
 * unreachable (timeout tier, explicit stop, etc.). These are infra transients:
 * the executor should reprovision and retry rather than failing the plan as
 * if the code were wrong.
 */
export function isSandboxGoneError(message: string | undefined | null | { message?: string; status?: number; statusCode?: number }): boolean {
  if (message && typeof message === 'object') {
    const status = Number(message.status ?? message.statusCode);
    if (status === 410 || status === 404) return true;
    return isSandboxGoneError(message.message);
  }
  if (message == null || !String(message).trim()) return false;
  const s = String(message).toLowerCase();
  if (/\b410\b/.test(s)) return true;
  if (/\b404\b/.test(s) && (s.includes('status code') || s.includes('not ok') || s.includes('apierror'))) return true;
  if (s.includes('stopped execution') && s.includes('gone')) return true;
  if (s.includes('sandbox has stopped')) return true;
  if (s.includes('microvm is unavailable')) return true;
  if (s.includes('sandbox microvm is unavailable')) return true;
  if (s.includes('retry-after') && (s.includes('gone') || s.includes('unavailable') || s.includes('410'))) return true;
  return false;
}
