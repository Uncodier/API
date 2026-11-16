import { lookup } from 'node:dns/promises';
import { createWriteStream } from 'node:fs';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { assertSafeRemoteUrl } from '../../security/safe-remote-url';

export const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const DNS_TIMEOUT_MS = 10_000;

export function allowedVideoHosts(env: NodeJS.Dict<string> = process.env): Set<string> {
  const hosts = new Set<string>();
  for (const entry of (env.VIDEO_ANALYSIS_ALLOWED_HOSTS ?? '').split(',')) {
    const host = entry.trim().toLowerCase();
    if (!host) continue;
    // Configuration contains exact hostnames, not URL prefixes or wildcards.
    if (!/^[a-z0-9.-]+$/.test(host) || host.includes('..') || host.endsWith('.')) {
      throw new Error('Invalid video host allowlist configuration');
    }
    hosts.add(host);
  }
  for (const storageUrl of [env.SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_URL].filter(Boolean)) {
    try {
      hosts.add(new URL(storageUrl!).hostname.toLowerCase());
    } catch {
      throw new Error('Invalid video storage configuration');
    }
  }
  return hosts;
}

export function validateVideoSourceUrl(value: string, hosts = allowedVideoHosts()): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid video URL');
  }
  if (url.protocol !== 'https:' || url.port || url.username || url.password
    || url.hash || value.includes('#') || !hosts.has(url.hostname.toLowerCase())) {
    throw new Error('Video URL is not allowed');
  }
  return url;
}

async function withDnsTimeout<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Video DNS validation timed out')), DNS_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function resolvePinnedVideoAddress(url: URL): Promise<{ address: string; family: number }> {
  return withDnsTimeout((async () => {
    await assertSafeRemoteUrl(url.toString());
    const addresses = await lookup(url.hostname, { all: true });
    if (!addresses.length) throw new Error('Video hostname has no addresses');
    for (const { address, family } of addresses) {
      if (isIP(address) !== family) throw new Error('Invalid video DNS address');
      // Reject IPv6 transition/mapped addresses; only global unicast is eligible.
      if (family === 6 && !/^[23][0-9a-f]{3}:/i.test(address)) {
        throw new Error('Video hostname resolves to a forbidden address');
      }
      // Validate the exact address used by lookup, not a second resolution of the hostname.
      await assertSafeRemoteUrl(`https://${family === 6 ? `[${address}]` : address}/`);
    }
    return addresses[0];
  })()).catch(() => { throw new Error('Video hostname is not safe or could not be resolved'); });
}

export function samePinnedAddress(actual: string | undefined, pinned: string): boolean {
  if (!actual) return false;
  const normalize = (address: string) => {
    const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (mapped) return mapped[1];
    if (isIP(address) === 6) return new URL(`https://[${address}]/`).hostname;
    return address;
  };
  return normalize(actual) === normalize(pinned);
}

/** Downloads only an allowlisted, DNS-verified HTTPS source, never following redirects. */
export async function downloadVideoSource(value: string, destination: string): Promise<void> {
  const url = validateVideoSourceUrl(value);
  const pinned = await resolvePinnedVideoAddress(url);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        req.destroy();
        reject(error);
      } else resolve();
    };
    const req = request(url, {
      method: 'GET',
      agent: false,
      family: pinned.family,
      // Preserve hostname/SNI/certificate validation while disabling further DNS resolution.
      lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
      headers: { Accept: 'video/*,application/octet-stream', 'Accept-Encoding': 'identity' },
    }, (response) => {
      if (!samePinnedAddress(response.socket.remoteAddress, pinned.address)) {
        response.destroy();
        finish(new Error('Video connection address did not match verified DNS'));
        return;
      }
      const length = response.headers['content-length'];
      if (response.statusCode !== 200 || (response.headers['content-encoding']
        && response.headers['content-encoding'] !== 'identity')) {
        response.destroy();
        finish(new Error('Video download was rejected (redirects are not allowed)'));
        return;
      }
      if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_SOURCE_BYTES)) {
        response.destroy();
        finish(new Error('Video source exceeds the download size limit'));
        return;
      }
      let bytes = 0;
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          callback(bytes > MAX_SOURCE_BYTES ? new Error('Video source exceeds the download size limit') : null,
            bytes <= MAX_SOURCE_BYTES ? chunk : undefined);
        },
      });
      pipeline(response, limiter, createWriteStream(destination, { flags: 'wx', mode: 0o600 }))
        .then(() => finish(bytes ? undefined : new Error('Video source is empty')))
        .catch(() => finish(new Error('Video download failed or exceeded its size limit')));
    });
    timer = setTimeout(() => finish(new Error('Video download timed out')), DOWNLOAD_TIMEOUT_MS);
    req.setTimeout(15_000, () => finish(new Error('Video download stalled')));
    req.on('error', () => finish(new Error('Video download failed')));
    req.end();
  });
}