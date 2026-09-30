import { lookup as dnsLookup } from 'node:dns';
import type { LookupAddress } from 'node:dns';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { RequestOptions } from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { LookupFunction } from 'node:net';

const MAX_MEDIA_BYTES = 64 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const TRANSFER_TIMEOUT_MS = 120_000;
const RESPONSE_TIMEOUT_MS = 10_000;

const blocked = new BlockList();
[
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].forEach(([address, prefix]) => blocked.addSubnet(String(address), Number(prefix), 'ipv4'));
[
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
].forEach(([address, prefix]) => blocked.addSubnet(String(address), Number(prefix), 'ipv6'));
const publicV6 = new BlockList();
publicV6.addSubnet('2000::', 3, 'ipv6');

type Media = { bytes: Uint8Array; contentType: string };

function isPublicAddress(address: string): boolean {
  if (address.includes('%')) return false;
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  // Fail closed outside global unicast, including mapped/compatible IPv4, NAT64,
  // loopback, unspecified, multicast, unique-local and link-local IPv6 addresses.
  return family === 6 && publicV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

function hostnameFor(url: URL): string {
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !url.hostname) {
    throw new Error('Invalid media transfer URL.');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  // Node skips lookup for literals, so they need the same validation here.
  if (isIP(hostname) && !isPublicAddress(hostname)) {
    throw new Error('Invalid media transfer destination.');
  }
  return hostname;
}

function publicLookup(signal: AbortSignal): LookupFunction {
  return (hostname, options, callback) => {
    let finished = false;
    const finish = (addresses?: LookupAddress[]) => {
      if (finished) return;
      finished = true;
      signal.removeEventListener('abort', onAbort);
      if (!addresses) callback(new Error('Media destination lookup failed.'), '');
      else if (options.all) callback(null, [addresses[0]]);
      else callback(null, addresses[0].address, addresses[0].family);
    };
    const onAbort = () => finish();
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) return finish();
    try {
      // This is the socket's actual resolver, not a vulnerable DNS preflight.
      // Validate every answer, then pin one; no subsequent lookup or retry occurs.
      dnsLookup(hostname, { all: true, order: 'verbatim' }, (error, addresses) => {
        if (finished) return;
        if (error || !Array.isArray(addresses) || !addresses.length || addresses.some((entry) =>
          !entry || typeof entry.address !== 'string' || isIP(entry.address) !== entry.family ||
          !isPublicAddress(entry.address))) return finish();
        finish(addresses);
      });
    } catch {
      finish();
    }
  };
}

function mediaType(value: unknown): string {
  if (typeof value !== 'string' || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error('Invalid media content type.');
  }
  const type = value.split(';', 1)[0].trim().toLowerCase();
  if (!/^(image|video)\/[a-z0-9][a-z0-9.+_-]*$/.test(type)) {
    throw new Error('Invalid media content type.');
  }
  return type;
}

function responseLength(response: IncomingMessage, limit: number, allowEmpty: boolean): number | undefined {
  const value = response.headers['content-length'];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value)) {
    throw new Error('Invalid media response size.');
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length > limit || length < (allowEmpty ? 0 : 1)) {
    throw new Error('Invalid media response size.');
  }
  return length;
}

function transfer(url: URL, maxBytes: number, signal: AbortSignal, body?: Media): Promise<Media | undefined> {
  const hostname = hostnameFor(url);
  return new Promise((resolve, reject) => {
    let request: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    let responseTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let requestFinished = false;
    let responseEnded = false;
    let buffer: Buffer | undefined;
    let size = 0;
    let contentType = '';
    let declaredLength: number | undefined;
    const cancellation = new AbortController();
    const deadline = setTimeout(() => fail('Media transfer timed out.'), TRANSFER_TIMEOUT_MS);
    deadline.unref();

    function cleanup() {
      clearTimeout(deadline);
      clearTimeout(responseTimer);
      signal.removeEventListener('abort', onAbort);
    }

    function fail(message = 'Media transfer failed.') {
      if (settled) return;
      settled = true;
      cleanup();
      buffer = undefined;
      cancellation.abort();
      response?.destroy();
      request?.destroy();
      reject(new Error(message));
    }

    function onAbort() {
      // Caller abort reasons and native errors may contain presigned URLs.
      fail('Media transfer aborted.');
    }

    function complete() {
      if (settled || !responseEnded || !requestFinished) return;
      settled = true;
      cleanup();
      resolve(body ? undefined : { bytes: buffer!.subarray(0, size), contentType });
      buffer = undefined;
    }

    function receive(incoming: IncomingMessage) {
      incoming.on('error', () => fail());
      if (settled) { incoming.destroy(); return; }
      response = incoming;
      incoming.once('aborted', () => fail('Incomplete media response.'));
      incoming.once('close', () => {
        if (!responseEnded) fail('Incomplete media response.');
      });
      const status = incoming.statusCode ?? 0;
      if (status < 200 || status >= 300 || (!body && (status === 206 || incoming.headers['content-range']))) {
        fail('Media transfer rejected.');
        return;
      }
      try {
        declaredLength = responseLength(incoming, maxBytes, Boolean(body));
        if (!body) {
          contentType = mediaType(incoming.headers['content-type']);
          const encoding = incoming.headers['content-encoding'];
          if (encoding && encoding !== 'identity') throw new Error();
          // One bounded allocation avoids unbounded chunk-array overhead and
          // double buffering. Zero initialization keeps unused backing bytes safe.
          buffer = Buffer.alloc(declaredLength ?? maxBytes);
        }
      } catch {
        fail('Invalid media response.');
        return;
      }
      if (body) {
        // Discard upload response data without parsing or retaining secrets.
        // A successful status alone must not accept an unfinished/endless body.
        responseTimer = setTimeout(() => fail('Media response timed out.'), RESPONSE_TIMEOUT_MS);
        responseTimer.unref();
      }
      incoming.on('data', (chunk: Buffer) => {
        if (settled) return;
        if (!Buffer.isBuffer(chunk) || chunk.length > maxBytes - size ||
            (declaredLength !== undefined && chunk.length > declaredLength - size)) {
          fail('Invalid media response size.');
          return;
        }
        if (!body) chunk.copy(buffer!, size);
        size += chunk.length;
      });
      incoming.once('end', () => {
        if (settled) return;
        if (!incoming.complete || (!body && size === 0) ||
            (declaredLength !== undefined && declaredLength !== size)) {
          fail('Incomplete media response.');
          return;
        }
        responseEnded = true;
        clearTimeout(responseTimer);
        complete();
      });
    }

    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) { onAbort(); return; }
    try {
      const options: RequestOptions & { autoSelectFamily: boolean } = {
        protocol: 'https:', hostname, path: `${url.pathname}${url.search}`,
        method: body ? 'PUT' : 'GET', agent: false, autoSelectFamily: false,
        maxHeaderSize: 16 * 1024, lookup: publicLookup(cancellation.signal),
        headers: body ? { 'Content-Type': body.contentType, 'Content-Length': body.bytes.byteLength } : {},
      };
      request = httpsRequest(options, receive);
      request.on('error', () => fail());
      request.once('finish', () => { requestFinished = true; complete(); });
      request.once('close', () => {
        if (!responseEnded || !requestFinished) fail('Incomplete media transfer.');
      });
      if (settled) request.destroy();
      else request.end(body?.bytes);
    } catch {
      fail();
    }
  });
}

/** The caller owns exact source host/path allowlists and expected extension/MIME matching. */
export async function downloadMedia(url: URL, maxBytes: number, signal: AbortSignal): Promise<Media> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_MEDIA_BYTES) {
    throw new Error('Invalid media size limit.');
  }
  const media = await transfer(url, maxBytes, signal);
  if (!media) throw new Error('Media transfer failed.');
  return media;
}

/** The caller owns the exact presigned upload host allowlist; no credentials are forwarded. */
export async function putMedia(url: URL, bytes: Uint8Array, contentType: string, signal: AbortSignal): Promise<void> {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > MAX_MEDIA_BYTES) {
    throw new Error('Invalid media upload size.');
  }
  await transfer(url, MAX_RESPONSE_BYTES, signal, { bytes, contentType: mediaType(contentType) });
}