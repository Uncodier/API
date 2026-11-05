import { request } from 'node:https';
import { downloadDocument } from '@/app/api/agents/tools/read_document/source';

export const SUPPORT_AUDIO_MAX_BYTES = 20 * 1024 * 1024;
export interface ScopedSupportTwilioAuth { siteId: string; accountSid: string; authToken: string }

/** The only authenticated hop is a fixed TLS Twilio origin and account media path.
 * Redirects are downloaded without credentials using read_document's DNS pinning,
 * private-network checks, redirect, streaming size and wall-clock limits. */
export async function downloadSupportAudio(url: URL, siteId: string, auth?: ScopedSupportTwilioAuth) {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Audio URL unavailable');
  if (url.hostname !== 'api.twilio.com') return downloadDocument(url.href);
  if (url.protocol !== 'https:' || url.port || url.search || !auth || auth.siteId !== siteId ||
      !/^AC[0-9a-f]{32}$/i.test(auth.accountSid) || !auth.authToken ||
      !new RegExp(`^/2010-04-01/Accounts/${auth.accountSid}/Messages/(?:SM|MM)[0-9a-f]{32}/Media/ME[0-9a-f]{32}$`, 'i').test(url.pathname)) {
    throw new Error('Audio authentication unavailable');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const result = await new Promise<{ location?: string; buffer?: Buffer; mimeType?: string }>((resolve, reject) => {
      const req = request(url, {
        method: 'GET', agent: false, signal: controller.signal,
        headers: { authorization: `Basic ${Buffer.from(`${auth.accountSid}:${auth.authToken}`).toString('base64')}` },
      }, async response => {
        try {
          const status = response.statusCode || 0;
          if (status >= 300 && status < 400 && response.headers.location) {
            response.destroy();
            resolve({ location: new URL(response.headers.location, url).href });
            return;
          }
          const size = Number(response.headers['content-length'] || 0);
          if (status < 200 || status >= 300 || !Number.isSafeInteger(size) || size < 0 || size > SUPPORT_AUDIO_MAX_BYTES) {
            response.destroy(); throw new Error('Audio download unavailable');
          }
          const chunks: Buffer[] = [];
          let total = 0;
          for await (const chunk of response) {
            total += chunk.length;
            if (total > SUPPORT_AUDIO_MAX_BYTES) { response.destroy(); throw new Error('Audio size limit'); }
            chunks.push(Buffer.from(chunk));
          }
          resolve({ buffer: Buffer.concat(chunks), mimeType: String(response.headers['content-type'] || '') });
        } catch { reject(new Error('Audio download unavailable')); }
      });
      req.on('error', () => reject(new Error('Audio download unavailable')));
      req.end();
    });
    if (result.location) return downloadDocument(result.location);
    return { buffer: result.buffer!, mimeType: result.mimeType || '', filename: 'audio' };
  } finally { clearTimeout(timer); }
}
