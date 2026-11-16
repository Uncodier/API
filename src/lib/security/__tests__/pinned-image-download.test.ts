import { randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { PassThrough } from 'node:stream';
import type { RequestOptions } from 'node:https';
import { downloadPinnedImage } from '../pinned-image-download';

jest.mock('node:https', () => ({ request: jest.fn() }));
jest.mock('node:dns/promises', () => ({ lookup: jest.fn() }));

const mockRequest = jest.mocked(request);
const mockDns = jest.mocked(lookup);
const ADDRESS = '93.184.216.34';
const SOURCE = 'https://images.example.invalid/image.png';
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const JPEG = Buffer.from([255, 216, 255, 224, 0]);
const LIMIT = 20 * 1024 * 1024;

class MockResponse extends PassThrough {
  headers: IncomingMessage['headers'] = { 'content-type': 'image/png' };
  statusCode = 200;
  socket = { remoteAddress: ADDRESS };
  complete = false;

  send(body: Buffer = PNG) {
    this.complete = true;
    this.end(body);
  }
}

class MockRequest extends EventEmitter {
  destroy = jest.fn(() => this);
  stall?: () => void;
  setTimeout = jest.fn((_ms: number, callback: () => void) => {
    this.stall = callback;
    return this;
  });
  end = jest.fn();
}

let response: MockResponse;
let req: MockRequest;
let serve: (incoming: MockResponse, outgoing: MockRequest) => void;
let capturedUrl: URL;
let capturedOptions: RequestOptions;

beforeEach(() => {
  jest.clearAllMocks();
  response = new MockResponse();
  req = new MockRequest();
  serve = (incoming) => incoming.send();
  // Real resolver and safe-remote-url execute; only OS DNS is replaced.
  mockDns.mockImplementation((async (hostname: string) => {
    if (hostname.includes('[') || hostname.includes(']')) throw Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' });
    const address = hostname;
    return [{ address: isIP(address) ? address : ADDRESS, family: isIP(address) || 4 }];
  }) as unknown as typeof lookup);
  mockRequest.mockImplementation(((url: URL, options: RequestOptions, callback: (r: IncomingMessage) => void) => {
    capturedUrl = url;
    capturedOptions = options;
    req.end.mockImplementation(() => {
      queueMicrotask(() => {
        callback(response as unknown as IncomingMessage);
        serve(response, req);
      });
    });
    return req as unknown as ClientRequest;
  }) as typeof request);
});

afterEach(() => {
  response.destroy();
  jest.useRealTimers();
});

async function waitForRequest() {
  for (let i = 0; i < 30 && !mockRequest.mock.calls.length; i++) await Promise.resolve();
  expect(mockRequest).toHaveBeenCalledTimes(1);
}

describe('downloadPinnedImage (offline built-in HTTPS)', () => {
  it.each([true, false])('accepts public IPv6 in DNS without bracketed lookups (dual stack: %s)', async dual => {
    const ipv6 = '2606:4700:4700::1111';
    const addresses = [...(dual ? [{ address: ADDRESS, family: 4 }] : []), { address: ipv6, family: 6 }];
    mockDns.mockImplementation((async (hostname: string) => {
      if (hostname.includes('[')) throw new Error('ENOTFOUND');
      return isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : addresses;
    }) as unknown as typeof lookup);
    response.socket.remoteAddress = dual ? ADDRESS : ipv6;
    expect(await downloadPinnedImage(SOURCE)).toEqual({ buffer: PNG, mimeType: 'image/png' });
    expect(mockDns.mock.calls.some(([host]) => host.includes('['))).toBe(false);
    expect(capturedOptions.family).toBe(dual ? 4 : 6);
  });
  it('pins lookup even after DNS rebinding, preserving TLS hostname and disabling pooling', async () => {
    const result = await downloadPinnedImage(SOURCE);
    expect(result).toEqual({ buffer: PNG, mimeType: 'image/png' });
    expect(capturedUrl.hostname).toBe('images.example.invalid');
    expect(capturedOptions).toMatchObject({
      method: 'GET', agent: false, family: 4,
      headers: { Accept: 'image/png,image/jpeg', 'Accept-Encoding': 'identity' },
    });
    expect(capturedOptions.rejectUnauthorized).not.toBe(false);
    expect(capturedOptions.checkServerIdentity).toBeUndefined();
    expect(capturedOptions.servername).toBeUndefined(); // Node derives SNI from the original URL.
    mockDns.mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as never);
    const dnsCalls = mockDns.mock.calls.length;
    const callback = jest.fn();
    const pinnedLookup = capturedOptions.lookup as (
      host: string, options: object, cb: typeof callback
    ) => void;
    pinnedLookup(capturedUrl.hostname, {}, callback);
    expect(callback).toHaveBeenCalledWith(null, ADDRESS, 4);
    expect(mockDns).toHaveBeenCalledTimes(dnsCalls);
    expect(req.setTimeout).toHaveBeenCalledWith(20_000, expect.any(Function));
  });

  it('accepts JPEG and normalized MIME with parameters', async () => {
    response.headers['content-type'] = ' IMAGE/JPEG; charset=binary';
    response.headers['content-encoding'] = 'identity';
    response.headers['content-length'] = String(JPEG.length);
    serve = (incoming) => incoming.send(JPEG);
    await expect(downloadPinnedImage(SOURCE)).resolves.toEqual({ buffer: JPEG, mimeType: 'image/jpeg' });
  });

  it('accepts an IPv4-mapped socket matching the verified address', async () => {
    response.socket.remoteAddress = `::ffff:${ADDRESS}`;
    await expect(downloadPinnedImage(SOURCE)).resolves.toHaveProperty('mimeType', 'image/png');
  });

  it.each(['127.0.0.1', '93.184.216.35', ''])('rejects mismatched response socket %s', async (address) => {
    response.socket.remoteAddress = address;
    await expect(downloadPinnedImage(SOURCE)).rejects.toThrow('Image download failed');
    expect(req.destroy).toHaveBeenCalled();
    expect(response.destroyed).toBe(true);
  });

  it('rejects a wrong socket at secureConnect before receiving a response', async () => {
    req.end.mockImplementation();
    mockRequest.mockImplementation((() => req as unknown as ClientRequest) as typeof request);
    const pending = downloadPinnedImage(SOURCE);
    const rejection = expect(pending).rejects.toThrow('Image download failed');
    await waitForRequest();
    const socket = Object.assign(new EventEmitter(), { remoteAddress: '127.0.0.1' });
    req.emit('socket', socket);
    socket.emit('secureConnect');
    await rejection;
    expect(req.destroy).toHaveBeenCalled();
  });

  it.each(['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', '2001:db8::1'])
  ('rejects a private candidate from the real resolver: %s', async (address) => {
    // Initial hostname validation succeeds; the resolver's candidate lookup then changes.
    mockDns.mockResolvedValueOnce([{ address: ADDRESS, family: 4 }] as never);
    mockDns.mockResolvedValueOnce([
      { address: ADDRESS, family: 4 }, { address, family: isIP(address) },
    ] as never);
    await expect(downloadPinnedImage(SOURCE)).rejects.toThrow('Image download failed');
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it.each(['http://images.example.invalid/a', 'not a URL', 'https://localhost/a', 'https://127.0.0.1/a', `${SOURCE}#fragment`])
  ('rejects unsafe URL without opening a connection: %s', async (url) => {
    await expect(downloadPinnedImage(url)).rejects.toThrow('Image download failed');
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('rejects runtime-generated credentials without revealing any sensitive value', async () => {
    const url = new URL(SOURCE);
    const username = randomBytes(18).toString('hex');
    const password = randomBytes(18).toString('hex');
    const token = randomBytes(18).toString('hex');
    url.username = username;
    url.password = password;
    url.searchParams.set('token', token);
    const error = await downloadPinnedImage(url.toString()).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    for (const secret of [username, password, token, url.toString()]) {
      expect(String(error)).not.toContain(secret);
    }
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it.each([301, 302, 307, 308, 404, 500])('rejects HTTP %s without following Location', async (status) => {
    response.statusCode = status;
    response.headers.location = 'https://other.example.invalid/image.png';
    await expect(downloadPinnedImage(SOURCE)).rejects.toThrow('Image download failed');
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, 'image/gif', 'image/svg+xml', 'text/html', 'application/octet-stream'])
  ('rejects unsupported MIME %s', async (mime) => {
    response.headers['content-type'] = mime;
    await expect(downloadPinnedImage(SOURCE)).rejects.toThrow('Image download failed');
  });

  it.each(['gzip', 'br', 'deflate', ''])('rejects content encoding %s', async (encoding) => {
    response.headers['content-encoding'] = encoding;
    await expect(downloadPinnedImage(SOURCE)).rejects.toThrow('Image download failed');
  });

  it.each([String(LIMIT + 1), '-1', 'abc', '1.5', ''])('rejects invalid/oversized length %s', async (length) => {
    response.headers['content-length'] = length;
    await expect(downloadPinnedImage(SOURCE)).rejects.toThrow('Image download failed');
    expect(response.destroyed).toBe(true);
  });

  it('accepts exactly 20 MiB', async () => {
    const body = Buffer.alloc(LIMIT);
    PNG.copy(body);
    response.headers['content-length'] = String(LIMIT);
    serve = (incoming) => incoming.send(body);
    await expect(downloadPinnedImage(SOURCE)).resolves.toHaveProperty('buffer.length', LIMIT);
  });

  it.each([false, true])('bounds streamed bytes even with a lying header: %s', async (withHeader) => {
    if (withHeader) response.headers['content-length'] = '9';
    serve = (incoming) => {
      const chunk = Buffer.alloc(1024 * 1024);
      PNG.copy(chunk);
      for (let i = 0; i < 21 && !incoming.destroyed; i++) incoming.write(chunk);
      incoming.complete = true;
      incoming.end();
    };
    await expect(downloadPinnedImage(SOURCE)).rejects.toThrow('Image download failed');
    expect(response.destroyed).toBe(true);
  });

  it.each([Buffer.alloc(0), Buffer.from('not an image'), JPEG])('rejects empty or MIME-mismatched body %#', async (body) => {
    serve = (incoming) => incoming.send(body);
    await expect(downloadPinnedImage(SOURCE)).rejects.toThrow('Image download failed');
  });

  it('rejects a truncated declared length', async () => {
    response.headers['content-length'] = '100';
    await expect(downloadPinnedImage(SOURCE)).rejects.toThrow('Image download failed');
  });

  it.each(['aborted', 'error', 'close'])('rejects interrupted streams: %s', async (event) => {
    serve = (incoming) => incoming.emit(event, new Error('transport detail'));
    await expect(downloadPinnedImage(SOURCE)).rejects.toThrow('Image download failed');
  });

  it('sanitizes request errors containing synthetic signed URL tokens', async () => {
    const token = randomBytes(24).toString('hex');
    const url = new URL(SOURCE);
    url.searchParams.set('signature', token);
    serve = (_incoming, outgoing) => outgoing.emit('error', new Error(url.toString()));
    const error = await downloadPinnedImage(url.toString()).catch((e: Error) => e);
    expect(String(error)).toBe('Error: Image download failed');
    expect(String(error)).not.toContain(token);
    expect(String(error)).not.toContain(url.toString());
  });

  it('sanitizes synchronous request exceptions', async () => {
    mockRequest.mockImplementation(() => { throw new Error(SOURCE); });
    await expect(downloadPinnedImage(SOURCE)).rejects.toThrow(/^Image download failed$/);
  });

  it('enforces the wall timeout even when bytes continue arriving', async () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
    serve = (incoming) => incoming.write(PNG);
    const pending = downloadPinnedImage(SOURCE);
    const rejection = expect(pending).rejects.toThrow('Image download failed');
    await waitForRequest();
    await jest.advanceTimersByTimeAsync(19_000);
    response.write(PNG);
    await jest.advanceTimersByTimeAsync(1_000);
    await rejection;
    expect(req.destroy).toHaveBeenCalled();
    expect(response.destroyed).toBe(true);
  });

  it('enforces the socket stall timeout', async () => {
    serve = () => req.stall!();
    await expect(downloadPinnedImage(SOURCE)).rejects.toThrow('Image download failed');
    expect(req.destroy).toHaveBeenCalled();
  });

  it('bounds DNS wait and never opens a late connection', async () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
    let finishDns!: (value: unknown) => void;
    mockDns.mockImplementation((() => new Promise<unknown>((resolve) => { finishDns = resolve; })) as typeof lookup);
    const pending = downloadPinnedImage(SOURCE);
    const rejection = expect(pending).rejects.toThrow('Image download failed');
    await jest.advanceTimersByTimeAsync(20_000);
    await rejection;
    finishDns([{ address: ADDRESS, family: 4 }]);
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(mockRequest).not.toHaveBeenCalled();
  });
});