import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { LookupAddress, LookupAllOptions } from 'node:dns';
import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { isIP } from 'node:net';
import { PassThrough } from 'node:stream';

type DnsCallback = (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void;
const lookup = jest.fn<(host: string, options: LookupAllOptions, callback: DnsCallback) => void>();
const request = jest.fn<(options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest>();
jest.unstable_mockModule('node:dns', () => ({ lookup }));
jest.unstable_mockModule('node:https', () => ({ request }));

let downloadMedia: typeof import('../media-transfer-http').downloadMedia;
let putMedia: typeof import('../media-transfer-http').putMedia;
beforeAll(async () => {
  ({ downloadMedia, putMedia } = await import('../media-transfer-http'));
});

const url = new URL('https://storage.example.test/photo.png?signature=never-log#not-sent');
const bytes = Buffer.from('test');
const instances: FakeRequest[] = [];
let answers: LookupAddress[];
let status: number;
let headers: IncomingHttpHeaders;
let responseAction: ((response: FakeResponse) => void) | undefined;
let holdLookup: boolean;
let holdConnection: boolean;
let holdFinish: boolean;
let lookupAll: boolean;

class FakeResponse extends PassThrough {
  statusCode = status;
  headers = headers;
  complete = false;

  finish(chunks: Buffer[] = [bytes], complete = true) {
    chunks.forEach((chunk) => this.write(chunk));
    this.complete = complete;
    this.end();
  }
}

class FakeRequest extends EventEmitter {
  destroyed = false;
  connected = false;
  sentBody?: Uint8Array;
  selected?: string | LookupAddress[];
  response?: FakeResponse;

  constructor(public options: RequestOptions, private callback: (response: IncomingMessage) => void) {
    super();
    instances.push(this);
  }

  end(body?: Uint8Array) {
    this.sentBody = body;
    if (!holdFinish) queueMicrotask(() => this.emit('finish'));
    if (!holdLookup) this.beginLookup();
    return this;
  }

  beginLookup() {
    const hostname = String(this.options.hostname);
    if (isIP(hostname)) { queueMicrotask(() => this.connect()); return; }
    // Emulate the resolver used by the connection itself, not a separate preflight.
    expect(this.options.lookup).toEqual(expect.any(Function));
    this.options.lookup!(hostname, { all: lookupAll }, (error, address) => {
      if (this.destroyed) return;
      if (error) this.emit('error', error);
      else { this.selected = address; this.connect(); }
    });
  }

  connect() {
    this.connected = true;
    if (this.destroyed || holdConnection) return;
    this.response = new FakeResponse();
    this.callback(this.response as unknown as IncomingMessage);
    queueMicrotask(() => responseAction?.(this.response!));
  }

  destroy() {
    this.destroyed = true;
    queueMicrotask(() => this.emit('close'));
    return this;
  }
}

function get(signal = new AbortController().signal, maxBytes = 16, target = url) {
  return downloadMedia(target, maxBytes, signal);
}

function put(signal = new AbortController().signal, target = url) {
  return putMedia(target, bytes, 'image/png', signal);
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  instances.length = 0;
  answers = [{ address: '93.184.216.34', family: 4 }];
  status = 200;
  headers = { 'content-type': 'image/png', 'content-length': '4' };
  responseAction = (response) => response.finish();
  holdLookup = holdConnection = holdFinish = lookupAll = false;
  lookup.mockReset().mockImplementation((_host, _options, callback) => {
    queueMicrotask(() => callback(null, answers));
  });
  request.mockReset().mockImplementation((options, callback) =>
    new FakeRequest(options, callback) as unknown as ClientRequest);
});

afterEach(() => {
  instances.forEach((instance) => instance.response?.destroy());
  jest.useRealTimers();
});

describe('secure HTTPS media transport', () => {
  it('pins the socket lookup and downloads exact bytes without authentication headers', async () => {
    expect(await get()).toEqual({ bytes, contentType: 'image/png' });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith(url.hostname, { all: true, order: 'verbatim' }, expect.any(Function));
    expect(instances[0].selected).toBe('93.184.216.34');
    expect(request.mock.calls[0][0]).toEqual({
      protocol: 'https:', hostname: url.hostname, path: '/photo.png?signature=never-log',
      method: 'GET', agent: false, autoSelectFamily: false, headers: {},
      maxHeaderSize: 16 * 1024, lookup: expect.any(Function),
    });
    expect(instances[0].sentBody).toBeUndefined();
  });

  it('supports public IPv6 and pins just one address even for an all-address callback', async () => {
    lookupAll = true;
    answers = [{ address: '2606:4700:4700::1111', family: 6 }, ...answers];
    headers['content-type'] = 'Video/MP4; codecs=avc1';
    expect((await get()).contentType).toBe('video/mp4');
    expect(instances[0].selected).toEqual([answers[0]]);
  });

  it.each(['https://8.8.8.8/photo.png', 'https://[2606:4700:4700::1111]/photo.png'])(
    'permits validated public literals without relying on lookup: %s', async (target) => {
      await expect(get(undefined, 16, new URL(target))).resolves.toEqual({ bytes, contentType: 'image/png' });
      expect(lookup).not.toHaveBeenCalled();
    });

  it.each([
    'http://storage.example.test/a', 'ftp://storage.example.test/a',
    'https://user:secret@storage.example.test/a', 'https://user@storage.example.test/a',
    'https://storage.example.test:8443/a', 'https://storage.example.test:80/a',
    'https://127.0.0.1/a', 'https://2130706433/a', 'https://0x7f000001/a',
    'https://169.254.169.254/a', 'https://[::1]/a', 'https://[::ffff:7f00:1]/a',
  ])('rejects unsafe URLs before transport on both hops: %s', async (target) => {
    await expect(get(undefined, 16, new URL(target))).rejects.toThrow('Invalid media transfer');
    await expect(put(undefined, new URL(target))).rejects.toThrow('Invalid media transfer');
    expect(request).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    '0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254',
    '172.16.0.1', '192.0.0.8', '192.0.2.1', '192.88.99.1', '192.168.1.1',
    '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '240.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a00:1', '::ffff:808:808',
    '::127.0.0.1', 'fc00::1', 'fd00::1', 'fe80::1', 'fe80::1%lo0', 'ff02::1',
    '64:ff9b::a00:1', '2001::1', '2001:db8::1', '2002:7f00:1::', '3fff::1', 'not-an-ip',
  ])('blocks nonpublic actual DNS answers on both hops: %s', async (address) => {
    answers = [{ address, family: isIP(address) || 4 }];
    await expect(get()).rejects.toThrow('Media transfer failed.');
    await expect(put()).rejects.toThrow('Media transfer failed.');
    expect(instances.every((instance) => !instance.connected && instance.destroyed)).toBe(true);
  });

  it('rejects every DNS answer rather than selecting a public entry from a mixed set', async () => {
    answers.push({ address: '10.0.0.1', family: 4 });
    await expect(get()).rejects.toThrow('Media transfer failed.');
    expect(instances[0].connected).toBe(false);
  });

  it('blocks rebinding when DNS changes before the actual socket lookup, not just preflight', async () => {
    await get();
    holdLookup = true;
    const transfer = get();
    expect(lookup).toHaveBeenCalledTimes(1);
    answers = [{ address: '169.254.169.254', family: 4 }];
    instances[1].beginLookup();
    await expect(transfer).rejects.toThrow('Media transfer failed.');
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(instances[1].connected).toBe(false);
  });

  it.each([{ records: [] }, { records: [{ address: '8.8.8.8', family: 6 }] }])('rejects absent or inconsistent DNS results', async ({ records }) => {
    answers = records;
    await expect(get()).rejects.toThrow('Media transfer failed.');
  });

  it.each([301, 302, 303, 307, 308, 400, 401, 403, 500])('rejects status %s without redirects or retries', async (code) => {
    status = code;
    headers.location = 'https://user:secret@169.254.169.254/private?signature=secret';
    await expect(get()).rejects.toThrow('Media transfer rejected.');
    await expect(put()).rejects.toThrow('Media transfer rejected.');
    expect(request).toHaveBeenCalledTimes(2);
    expect(instances.every((instance) => instance.response?.destroyed)).toBe(true);
  });

  it.each([0, -1, 1.5, NaN, Infinity, 64 * 1024 * 1024 + 1])('rejects invalid source size cap %s', async (limit) => {
    await expect(get(undefined, limit)).rejects.toThrow('Invalid media size limit.');
    expect(request).not.toHaveBeenCalled();
  });

  it.each(['0', '-1', '17', '1.5', '+4', '4,4', 'x', '9007199254740992', ['4', '4']])(
    'rejects invalid or oversized declared lengths %s before consuming bytes', async (length) => {
      headers['content-length'] = length as string;
      await expect(get()).rejects.toThrow('Invalid media response.');
      expect(instances[0].response?.destroyed).toBe(true);
    });

  it('bounds actual chunk bytes when length is missing and accepts exactly the cap', async () => {
    delete headers['content-length'];
    responseAction = (response) => response.finish([Buffer.from('é'), Buffer.from('ab')]);
    expect((await get(undefined, 4)).bytes).toEqual(Buffer.from('éab'));
    await expect(get(undefined, 3)).rejects.toThrow('Invalid media response size.');
  });

  it.each(['3', '8'])('rejects lying content-length %s on overflow or underflow', async (length) => {
    headers['content-length'] = length;
    await expect(get()).rejects.toThrow(/media response/i);
  });

  it('rejects an empty body without content-length', async () => {
    delete headers['content-length'];
    responseAction = (response) => response.finish([]);
    await expect(get()).rejects.toThrow('Incomplete media response.');
  });

  it.each([undefined, 'text/html', 'application/octet-stream', 'image/*', 'image/png\r\nsecret'])('rejects invalid MIME %s', async (type) => {
    headers['content-type'] = type;
    await expect(get()).rejects.toThrow('Invalid media response.');
  });

  it('rejects partial and encoded media even with a successful status', async () => {
    status = 206;
    await expect(get()).rejects.toThrow('Media transfer rejected.');
    status = 200;
    headers['content-range'] = 'bytes 0-3/8';
    await expect(get()).rejects.toThrow('Media transfer rejected.');
    delete headers['content-range'];
    headers['content-encoding'] = 'gzip';
    await expect(get()).rejects.toThrow('Invalid media response.');
  });

  it.each(['partial', 'aborted', 'error', 'close'])('rejects %s response streams on both hops', async (event) => {
    responseAction = (response) => {
      if (event === 'partial') response.finish([bytes], false);
      else if (event === 'error') response.emit('error', new Error('secret signature'));
      else response.emit(event);
    };
    await expect(get()).rejects.toThrow(/media (response|transfer)/i);
    await expect(put()).rejects.toThrow(/media (response|transfer)/i);
  });

  it('PUT sends only MIME and byte length, discards response secrets, and returns void', async () => {
    delete headers['content-length'];
    responseAction = (response) => response.finish([Buffer.from('not JSON: secret signature')]);
    expect(await put()).toBeUndefined();
    expect(instances[0].options.headers).toEqual({ 'Content-Type': 'image/png', 'Content-Length': 4 });
    expect(instances[0].options.method).toBe('PUT');
    expect(instances[0].options.agent).toBe(false);
    expect(instances[0].sentBody).toBe(bytes);
    expect(instances[0].options).not.toHaveProperty('auth');
  });

  it('accepts an empty complete PUT response, but waits for request completion too', async () => {
    status = 204;
    headers = { 'content-length': '0' };
    holdFinish = true;
    responseAction = (response) => response.finish([]);
    let resolved = false;
    const transfer = put().then(() => { resolved = true; });
    await flush();
    expect(resolved).toBe(false);
    instances[0].emit('finish');
    await transfer;
    expect(resolved).toBe(true);
  });

  it('bounds discarded PUT response bytes with and without declared length', async () => {
    headers['content-length'] = '65537';
    await expect(put()).rejects.toThrow('Invalid media response.');
    delete headers['content-length'];
    responseAction = (response) => response.finish([Buffer.alloc(65537)]);
    await expect(put()).rejects.toThrow('Invalid media response size.');
  });

  it('rejects empty/oversized uploads and header injection before making requests', async () => {
    const signal = new AbortController().signal;
    await expect(putMedia(url, new Uint8Array(), 'image/png', signal)).rejects.toThrow('Invalid media upload size.');
    await expect(putMedia(url, new Uint8Array(64 * 1024 * 1024 + 1), 'image/png', signal)).rejects.toThrow('Invalid media upload size.');
    await expect(putMedia(url, bytes, 'image/png\r\nAuthorization: secret', signal)).rejects.toThrow('Invalid media content type.');
    expect(request).not.toHaveBeenCalled();
  });

  it('honors an already aborted signal without DNS/transport or exposing its reason', async () => {
    const controller = new AbortController();
    controller.abort(new Error(url.href));
    await expect(get(controller.signal)).rejects.toThrow('Media transfer aborted.');
    await expect(put(controller.signal)).rejects.toThrow('Media transfer aborted.');
    expect(request).not.toHaveBeenCalled();
  });

  it('aborts during pending DNS and ignores its late callback', async () => {
    let callback: DnsCallback | undefined;
    lookup.mockImplementation((_host, _options, cb) => { callback = cb; });
    const controller = new AbortController();
    const transfer = get(controller.signal);
    controller.abort(url.href);
    await expect(transfer).rejects.toThrow('Media transfer aborted.');
    callback!(null, answers);
    expect(instances[0].destroyed).toBe(true);
    expect(instances[0].connected).toBe(false);
  });

  it.each(['connect', 'GET body', 'PUT body'])('aborts the entire operation during %s', async (phase) => {
    holdConnection = phase === 'connect';
    responseAction = undefined;
    const controller = new AbortController();
    const transfer = phase === 'PUT body' ? put(controller.signal) : get(controller.signal);
    await flush();
    controller.abort();
    await expect(transfer).rejects.toThrow('Media transfer aborted.');
    expect(instances[0].destroyed).toBe(true);
    if (!holdConnection) expect(instances[0].response?.destroyed).toBe(true);
  });

  it.each(['DNS', 'connect', 'GET body', 'PUT body'])('bounds a stalled %s independently of socket activity', async (phase) => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
    responseAction = undefined;
    holdConnection = phase === 'connect';
    if (phase === 'DNS') lookup.mockImplementation(() => {});
    const transfer = phase === 'PUT body' ? put() : get();
    const assertion = expect(transfer).rejects.toThrow(/timed out/);
    await flush();
    await jest.advanceTimersByTimeAsync(phase === 'PUT body' ? 10_000 : 120_000);
    await assertion;
    expect(instances[0].destroyed).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('supports caller AbortSignal.timeout during an endless response', async () => {
    responseAction = undefined;
    await expect(get(AbortSignal.timeout(20))).rejects.toThrow('Media transfer aborted.');
    expect(instances[0].response?.destroyed).toBe(true);
  });

  it('does not reset the total download deadline when a response trickles bytes', async () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
    delete headers['content-length'];
    responseAction = undefined;
    const transfer = get();
    const assertion = expect(transfer).rejects.toThrow('Media transfer timed out.');
    await flush();
    await jest.advanceTimersByTimeAsync(60_000);
    instances[0].response!.write(Buffer.from('a'));
    await jest.advanceTimersByTimeAsync(59_999);
    instances[0].response!.write(Buffer.from('b'));
    await jest.advanceTimersByTimeAsync(1);
    await assertion;
    expect(instances[0].response?.destroyed).toBe(true);
  });

  it('clears deadlines and caller abort listeners after a complete transfer', async () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
    const controller = new AbortController();
    const removeListener = jest.spyOn(controller.signal, 'removeEventListener');
    await get(controller.signal);
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(jest.getTimerCount()).toBe(0);
    controller.abort();
    expect(instances[0].destroyed).toBe(false);
  });

  it('sanitizes DNS and request errors, including synchronous request failure', async () => {
    lookup.mockImplementation((_host, _options, callback) => callback(new Error(url.href), []));
    await expect(get()).rejects.toThrow('Media transfer failed.');
    request.mockImplementationOnce(() => { throw new Error(url.href); });
    await expect(put()).rejects.toThrow('Media transfer failed.');
    expect(request).toHaveBeenCalledTimes(2);
  });
});