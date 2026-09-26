import { lookup } from 'node:dns/promises';
import { request as requestHttp, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as requestHttps } from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { LoadedDocument } from './types';

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const TIMEOUT_MS = 20_000;
const ACCEPT = 'application/pdf,application/vnd.openxmlformats-officedocument.*,text/*,*/*;q=0.5';
type Address = { address: string; family: 4 | 6 };

function parseIpv4(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some(part => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) return null;
  return parts.reduce((value, part) => ((value << 8) | Number(part)) >>> 0, 0);
}

function ipv4InCidr(value: number, base: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (base & mask);
}

const RESERVED_IPV4: Array<[number, number]> = [
  [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8],
  [0xa9fe0000, 16], [0xac100000, 12], [0xc0000000, 24], [0xc0000200, 24],
  [0xc0a80000, 16], [0xc6120000, 15], [0xc6336400, 24], [0xcb007100, 24],
  [0xe0000000, 4], [0xf0000000, 4],
];

const reservedIpv6 = new BlockList();
[
  ['::', 128], ['::1', 128], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32],
  ['2001:2::', 48], ['2001:10::', 28], ['2001:db8::', 32], ['2002::', 16],
  ['3fff::', 20], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
].forEach(([network, prefix]) => reservedIpv6.addSubnet(network as string, prefix as number, 'ipv6'));

function normalizedAddress(address: string): string {
  const unzoned = address.toLowerCase().split('%')[0]!;
  return unzoned.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1] ?? unzoned;
}

export function isPublicAddress(address: string): boolean {
  const normalized = normalizedAddress(address);
  const ipv4 = parseIpv4(normalized);
  if (ipv4 !== null) return !RESERVED_IPV4.some(([base, prefix]) => ipv4InCidr(ipv4, base, prefix));
  if (isIP(normalized) !== 6) return false;
  return /^[23][0-9a-f]{0,3}:/.test(normalized) && !reservedIpv6.check(normalized, 'ipv6');
}

async function resolvePublic(url: URL, signal: AbortSignal): Promise<Address> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const family = isIP(hostname);
  const dnsResult = family ? Promise.resolve([{ address: hostname, family }]) : lookup(hostname, { all: true, verbatim: true });
  const aborted = new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  const addresses = await Promise.race([dnsResult, aborted]);
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new Error('Document URL resolves to a private or reserved network address.');
  return { address: addresses[0]!.address, family: addresses[0]!.family as 4 | 6 };
}

function parseUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('url must be a valid HTTP(S) URL.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only HTTP(S) document URLs are supported.');
  if (url.username || url.password) throw new Error('URLs containing credentials are not allowed.');
  if (url.hostname === 'localhost' || url.hostname.endsWith('.localhost')) throw new Error('Local document URLs are not allowed.');
  return url;
}

function requestPinned(url: URL, pinned: Address, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const options: RequestOptions = {
      protocol: url.protocol, hostname: url.hostname.replace(/^\[|\]$/g, ''), port: url.port || undefined,
      path: `${url.pathname}${url.search}`, method: 'GET', signal, agent: false,
      headers: { accept: ACCEPT },
      lookup: (_hostname, lookupOptions, callback) => {
        if (typeof lookupOptions === 'object' && lookupOptions.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
        else callback(null, pinned.address, pinned.family);
      },
    };
    if (url.protocol === 'https:') (options as RequestOptions & { servername: string }).servername = url.hostname.replace(/^\[|\]$/g, '');
    const request = (url.protocol === 'https:' ? requestHttps : requestHttp)(options, resolve);
    request.once('socket', socket => {
      socket.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
        if (normalizedAddress(socket.remoteAddress || '') !== normalizedAddress(pinned.address)) request.destroy(new Error('Document connection did not use the validated network address.'));
      });
    });
    request.once('error', reject);
    request.end();
  });
}

function filenameFromResponse(url: URL, disposition: string | undefined): string {
  const encoded = disposition?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const plain = disposition?.match(/filename="?([^";]+)"?/i)?.[1];
  let candidate = plain || url.pathname.split('/').pop();
  if (encoded) { try { candidate = decodeURIComponent(encoded); } catch { /* Ignore malformed optional header. */ } }
  return (candidate || 'document').replace(/[\\/\0]/g, '_');
}

async function readBody(response: IncomingMessage): Promise<Buffer> {
  const header = response.headers['content-length'];
  const declared = header === undefined ? 0 : Number(header);
  if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_BYTES) {
    response.destroy();
    throw new Error('Document exceeds the 20 MB limit or has an invalid Content-Length.');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of response) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.length;
    if (size > MAX_BYTES) { response.destroy(); throw new Error('Document exceeds the 20 MB limit.'); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

export async function downloadDocument(source: string): Promise<LoadedDocument> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Document download timed out.')), TIMEOUT_MS);
  let url = parseUrl(source);
  try {
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      const response = await requestPinned(url, await resolvePublic(url, controller.signal), controller.signal);
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
        const location = response.headers.location;
        response.resume();
        if (!location || redirect === MAX_REDIRECTS) throw new Error('Too many or invalid document redirects.');
        url = parseUrl(new URL(location, url).toString());
        continue;
      }
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        throw new Error(`Document download failed with HTTP ${response.statusCode || 0}.`);
      }
      return { buffer: await readBody(response), filename: filenameFromResponse(url, response.headers['content-disposition']), mimeType: String(response.headers['content-type'] || '').split(';')[0]!.trim().toLowerCase() };
    }
    throw new Error('Document download failed.');
  } finally { clearTimeout(timer); }
}