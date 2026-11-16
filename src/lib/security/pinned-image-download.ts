import type { ClientRequest, IncomingMessage } from 'node:http';
import { request } from 'node:https';
import { resolvePinnedVideoAddress, samePinnedAddress } from '../services/video-analysis/media-download';

const MAX_BYTES = 20 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Node-only HTTPS download. DNS is validated once, then pinned without changing TLS identity. */
export function downloadPinnedImage(value: string): Promise<{ buffer: Buffer; mimeType: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let req: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    const timer = setTimeout(() => fail(), TIMEOUT_MS);
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      response?.destroy();
      req?.destroy();
      // Never expose URLs, credentials, DNS results, or underlying transport errors.
      reject(new Error('Image download failed'));
    };

    void (async () => {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || url.hash || value.includes('#')) {
        throw new Error('Image download failed');
      }
      const pinned = await resolvePinnedVideoAddress(url);
      if (settled) return;
      req = request(url, {
        method: 'GET',
        agent: false,
        family: pinned.family,
        // Keep the URL hostname for Host, SNI, and normal certificate verification.
        lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
        headers: { Accept: 'image/png,image/jpeg', 'Accept-Encoding': 'identity' },
      }, (incoming) => {
        response = incoming;
        incoming.on('error', fail);
        incoming.on('aborted', fail);
        incoming.on('close', () => { if (!incoming.complete) fail(); });
        if (settled) { incoming.destroy(); return; }
        const length = incoming.headers['content-length'];
        const encoding = incoming.headers['content-encoding'];
        const contentType = incoming.headers['content-type'];
        const mimeType = typeof contentType === 'string' ? contentType.split(';', 1)[0].trim().toLowerCase() : '';
        if (!samePinnedAddress(incoming.socket.remoteAddress, pinned.address)
          || incoming.statusCode !== 200
          || (encoding !== undefined && encoding !== 'identity')
          || (mimeType !== 'image/png' && mimeType !== 'image/jpeg')
          || (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES))) {
          fail();
          return;
        }
        let bytes = 0;
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => {
          if (settled) return;
          if (!Buffer.isBuffer(chunk) || chunk.length > MAX_BYTES - bytes) { fail(); return; }
          bytes += chunk.length;
          chunks.push(chunk);
        });
        incoming.on('end', () => {
          if (settled) return;
          if (!incoming.complete || !bytes || (length !== undefined && Number(length) !== bytes)) { fail(); return; }
          const buffer = Buffer.concat(chunks, bytes);
          const validSignature = mimeType === 'image/png'
            ? buffer.subarray(0, 8).equals(PNG_SIGNATURE)
            : buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
          if (!validSignature) { fail(); return; }
          settled = true;
          clearTimeout(timer);
          resolve({ buffer, mimeType });
        });
      });
      req.on('error', fail);
      req.on('socket', (socket) => {
        socket.once('secureConnect', () => {
          if (!samePinnedAddress(socket.remoteAddress, pinned.address)) fail();
        });
      });
      req.setTimeout(TIMEOUT_MS, fail);
      req.end();
    })().catch(fail);
  });
}