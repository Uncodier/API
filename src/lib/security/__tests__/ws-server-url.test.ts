import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { createServer } from 'node:http';
import { resolve } from 'node:path';
import url from 'node:url';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { WebSocketServer } from 'ws';
import { parseWebSocketRequestUrl } from '../../../../wsServerUrl.cjs';
import { loadRuntimeModule } from '@/lib/custom-automation/test-helpers/load-runtime-module';

jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('node:http', () => ({ createServer: jest.fn() }));
jest.mock('ws', () => ({ WebSocketServer: jest.fn() }));
jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn() }));
jest.mock('../../../../wsServerConnection.cjs', () => ({ handleConnection: jest.fn() }));

const endpoints = ['/ws', '/api/agents/chat/websocket'];
const securityParameters = ['site_id', 'session_id', 'visitor_id', 'conversation_id'];
const environmentKeys = [
  'VISITOR_SESSION_TOKEN_SECRET', 'ENCRYPTION_KEY', 'NEXT_PUBLIC_SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY',
] as const;
const originalEnvironment = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));

function originTarget(value: URL) {
  return `${value.pathname}${value.search}`;
}

function identifierUrl(pathname = '/ws') {
  const value = new URL(pathname, 'http://websocket.invalid');
  for (const name of securityParameters) value.searchParams.set(name, randomUUID());
  return value;
}

beforeEach(() => {
  jest.spyOn(url, 'parse').mockImplementation(() => {
    throw new Error('Legacy URL parsing must not be invoked');
  });
});

afterEach(() => {
  expect(url.parse).not.toHaveBeenCalled();
  jest.restoreAllMocks();
});

describe('local WebSocket origin-form URL parsing', () => {
  it.each(endpoints)('parses %s with missing query values still undefined', pathname => {
    const parsed = parseWebSocketRequestUrl(pathname);
    expect(parsed?.pathname).toBe(pathname);
    for (const name of securityParameters) expect(parsed?.query[name]).toBeUndefined();
  });

  it.each(endpoints)('retains all consumed query values for %s', pathname => {
    const value = identifierUrl(pathname);
    const parsed = parseWebSocketRequestUrl(originTarget(value));
    expect(parsed?.pathname).toBe(pathname);
    for (const name of securityParameters) {
      expect(parsed?.query[name]).toBe(value.searchParams.get(name));
      expect(typeof parsed?.query[name]).toBe('string');
    }
  });

  it('distinguishes empty and missing values, including a key without an equals sign', () => {
    expect(parseWebSocketRequestUrl('/ws?site_id=&session_id')?.query).toMatchObject({
      site_id: '', session_id: '', visitor_id: undefined, conversation_id: undefined,
    });
  });

  it('decodes encoded keys and values once, including Unicode, plus and delimiters', () => {
    const parsed = parseWebSocketRequestUrl(
      '/ws?s%69te_id=site%2Fone%26two%3Dthree&session_id=a+b%2Bc&visitor_id=%E2%9C%93'
      + '&conversation_id=%252F%3F%23%25',
    );
    expect(parsed?.query).toMatchObject({
      site_id: 'site/one&two=three', session_id: 'a b+c', visitor_id: '✓',
      conversation_id: '%2F?#%',
    });
  });

  it('ignores unused query parameters, including duplicates and object-property names', () => {
    const parsed = parseWebSocketRequestUrl('/ws?unused=a&unused=b&__proto__=x&constructor=y');
    expect(parsed?.pathname).toBe('/ws');
    expect(Object.getPrototypeOf(parsed?.query)).toBeNull();
    expect(Object.keys(parsed?.query ?? {})).toEqual(securityParameters);
  });

  it.each(securityParameters)('rejects duplicates of %s instead of selecting a value', name => {
    const value = identifierUrl();
    for (const duplicate of [value.searchParams.get(name)!, randomUUID(), '']) {
      const duplicated = new URL(value);
      duplicated.searchParams.append(name, duplicate);
      expect(parseWebSocketRequestUrl(originTarget(duplicated))).toBeNull();
    }
    expect(parseWebSocketRequestUrl(`/ws?${name}&${name}=`)).toBeNull();
  });

  it.each(securityParameters)('detects percent-encoded duplicates of %s', name => {
    const value = identifierUrl();
    const encodedName = `%${name.charCodeAt(0).toString(16)}${name.slice(1)}`;
    expect(parseWebSocketRequestUrl(`${originTarget(value)}&${encodedName}=`)).toBeNull();
    const target = originTarget(value).replace(`${name}=`, `${encodedName}=`);
    expect(parseWebSocketRequestUrl(`${target}&${name}=`)).toBeNull();
  });

  it.each([undefined, null, 42, {}, new URL('http://websocket.invalid/ws')])(
    'fails closed for a non-string input (%s)', value => {
      expect(parseWebSocketRequestUrl(value)).toBeNull();
    },
  );

  it.each([
    '', 'ws', '?site_id=x', '*', 'websocket.invalid:3002',
    '//websocket.invalid/ws', '///ws', '//[::1]/ws',
    'http://websocket.invalid/ws', 'https://example.invalid/ws', 'ws://example.invalid/ws',
    '/\\websocket.invalid/ws', '\\ws', '/api/agents/chat\\websocket', '/ws?site_id=a\\b',
    ' /ws', '/ws ', '/ws?site_id=a b', '/ws#fragment',
    '/a/../ws', '/./ws', '/%2e/ws', '/a/%2E%2e/ws',
    '/ws?site_id=%', '/ws?site_id=%0', '/ws?site_id=%GG', '/ws?site_id=%FF',
    '/ws?site_id=%C0%AF', '/ws?site_id=%E2%82', '/ws?%FF=x', '/ws?unused=%GG',
  ])('rejects malformed or non-origin-form target %j', target => {
    expect(() => parseWebSocketRequestUrl(target)).not.toThrow();
    expect(parseWebSocketRequestUrl(target)).toBeNull();
  });

  it('accepts an empty query delimiter', () => {
    expect(parseWebSocketRequestUrl('/ws?')?.pathname).toBe('/ws');
  });

  it.each([...Array.from({ length: 33 }, (_, index) => index), 127])(
    'rejects raw whitespace/control character %i before URL normalization', code => {
      const character = String.fromCharCode(code);
      for (const target of [`${character}/ws`, `/w${character}s`, `/ws?site_id=a${character}b`, `/ws${character}`]) {
        expect(parseWebSocketRequestUrl(target)).toBeNull();
      }
    },
  );

  it('rejects absolute URLs with synthetic userinfo even on the fixed base host', () => {
    const value = identifierUrl();
    value.username = randomBytes(16).toString('hex');
    value.password = randomBytes(32).toString('hex');
    expect(parseWebSocketRequestUrl(value.href)).toBeNull();
  });

  it('contains no legacy node:url import or parse invocation in production files', () => {
    const source = ['wsServer.js', 'wsServerUrl.cjs']
      .map(file => readFileSync(resolve(__dirname, '../../../..', file), 'utf8')).join('\n');
    expect(source).not.toMatch(/(?:from\s*|require\s*\(\s*)['"](?:node:)?url['"]/);
    expect(source).not.toMatch(/\b(?:url\.)?parse\s*\(/);
    expect(source).toContain('new URL(requestUrl, REQUEST_BASE)');
    expect(source).toContain('authorizeWebSocketUpgrade(request');
  });
});

type UpgradeRequest = { url: string | undefined; headers: Record<string, string> };
type UpgradeSocket = { write: jest.Mock; destroy: jest.Mock };
type UpgradeHandler = (request: UpgradeRequest, socket: UpgradeSocket, head: Buffer) => void;

describe('offline wsServer upgrade integration', () => {
  let upgrade: UpgradeHandler;
  let socket: UpgradeSocket;
  let head: Buffer;
  let websocket: object;
  let websocketConstructor: jest.Mock<(...args: ConstructorParameters<typeof WebSocketServer>) => WebSocketServer>;
  let wss: { on: jest.Mock; emit: jest.Mock; handleUpgrade: jest.Mock<(
    request: UpgradeRequest, socket: UpgradeSocket, head: Buffer, callback: (ws: object) => void
  ) => void> };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    jest.useFakeTimers();
    environmentKeys.forEach(key => { delete process.env[key]; });
    process.env.VISITOR_SESSION_TOKEN_SECRET = randomBytes(32).toString('hex');
    socket = { write: jest.fn(), destroy: jest.fn() };
    head = Buffer.alloc(0);
    websocket = {};
    wss = {
      on: jest.fn(), emit: jest.fn(),
      handleUpgrade: jest.fn((_request, _socket, _head, callback: (ws: object) => void) => callback(websocket)),
    };
    const server = { on: jest.fn<(event: string, handler: unknown) => void>(), listen: jest.fn() };
    // Only this isolated, fully mocked import executes the entrypoint. No env files,
    // HTTP listeners, real WebSocket server, database clients or status timers run.
    jest.isolateModules(() => {
      const serverFactory = require('node:http').createServer as jest.MockedFunction<typeof createServer>;
      websocketConstructor = require('ws').WebSocketServer;
      serverFactory.mockReturnValue(server as unknown as ReturnType<typeof createServer>);
      websocketConstructor.mockImplementation(() => wss as unknown as WebSocketServer);
      // Transpile the real JS entrypoint behind the existing fail-closed VM boundary
      // so the test also works with the repository's TS-only Jest transforms.
      loadRuntimeModule('wsServer.js', {
        dotenv: require('dotenv'),
        'node:http': require('node:http'),
        ws: require('ws'),
        '@supabase/supabase-js': require('@supabase/supabase-js'),
        './wsServerAuth.cjs': require('../../../../wsServerAuth.cjs'),
        './wsServerConnection.cjs': require('../../../../wsServerConnection.cjs'),
        './wsServerUrl.cjs': require('../../../../wsServerUrl.cjs'),
      });
      expect(require('@supabase/supabase-js').createClient).not.toHaveBeenCalled();
      expect(require('dotenv').config).toHaveBeenCalledWith({ path: '.env.local' });
    });
    upgrade = server.on.mock.calls.find(([event]) => event === 'upgrade')?.[1] as UpgradeHandler;
    expect(upgrade).toEqual(expect.any(Function));
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    environmentKeys.forEach(key => {
      const value = originalEnvironment[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  });

  function authenticatedRequest(value: URL, overrides: Record<string, unknown> = {}) {
    const claims = {
      siteId: value.searchParams.get('site_id'), sessionId: value.searchParams.get('session_id'),
      visitorId: value.searchParams.get('visitor_id'), expiresAt: Date.now() + 60_000,
      ...overrides,
    };
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const signature = createHmac('sha256', process.env.VISITOR_SESSION_TOKEN_SECRET!)
      .update(payload).digest('base64url');
    return {
      claims,
      request: {
        url: originTarget(value),
        headers: { 'sec-websocket-protocol': `visitor-session-token, ${payload}.${signature}` },
      },
    };
  }

  function expectRejected() {
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(wss.handleUpgrade).not.toHaveBeenCalled();
    expect(wss.emit).not.toHaveBeenCalled();
  }

  it.each(endpoints)('authorizes %s and forwards original request, claims and conversation', pathname => {
    const value = identifierUrl(pathname);
    // Delimiters and Unicode must survive URL decoding before the claims comparison.
    for (const name of securityParameters) value.searchParams.set(name, `${randomUUID()} +/&=✓%`);
    const { request, claims } = authenticatedRequest(value);
    upgrade(request, socket, head);
    expect(socket.destroy).not.toHaveBeenCalled();
    expect(socket.write).not.toHaveBeenCalled();
    expect(wss.handleUpgrade).toHaveBeenCalledWith(request, socket, head, expect.any(Function));
    expect(wss.emit).toHaveBeenCalledWith('connection', websocket, request, {
      site_id: claims.siteId, session_id: claims.sessionId,
      conversation_id: value.searchParams.get('conversation_id'), claims,
    });
    expect(websocketConstructor.mock.calls[0]?.[0]).toMatchObject({
      noServer: true, handleProtocols: expect.any(Function),
    });
  });

  it.each([undefined, ''])('preserves an optional conversation value of %s', conversation => {
    const value = identifierUrl();
    if (conversation === undefined) value.searchParams.delete('conversation_id');
    else value.searchParams.set('conversation_id', conversation);
    const { request, claims } = authenticatedRequest(value);
    upgrade(request, socket, head);
    expect(wss.emit).toHaveBeenCalledWith('connection', websocket, request, {
      site_id: claims.siteId, session_id: claims.sessionId, conversation_id: conversation, claims,
    });
  });

  it.each(securityParameters)('never upgrades a request with duplicate %s, even when the first value matches', name => {
    const value = identifierUrl();
    const { request } = authenticatedRequest(value);
    for (const duplicate of [value.searchParams.get(name)!, randomUUID(), '']) {
      socket.destroy.mockClear();
      const duplicated = new URL(value);
      duplicated.searchParams.append(name, duplicate);
      upgrade({ ...request, url: originTarget(duplicated) }, socket, head);
      expectRejected();
    }
    const encodedName = `%${name.charCodeAt(0).toString(16)}${name.slice(1)}`;
    socket.destroy.mockClear();
    upgrade({ ...request, url: `${request.url}&${encodedName}=` }, socket, head);
    expectRejected();
  });

  it.each(['site_id', 'session_id', 'visitor_id'])('rejects missing, empty or mismatched %s with 401', name => {
    const value = identifierUrl();
    const { request } = authenticatedRequest(value);
    for (const replacement of [undefined, '', randomUUID()]) {
      socket.destroy.mockClear();
      socket.write.mockClear();
      const changed = new URL(value);
      if (replacement === undefined) changed.searchParams.delete(name);
      else changed.searchParams.set(name, replacement);
      upgrade({ ...request, url: originTarget(changed) }, socket, head);
      expectRejected();
      expect(socket.write).toHaveBeenCalledWith('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    }
  });

  it.each(['missing', 'malformed', 'tampered', 'expired'])('still rejects %s authentication', kind => {
    const value = identifierUrl();
    const { request } = authenticatedRequest(value, kind === 'expired' ? { expiresAt: Date.now() - 1 } : {});
    if (kind === 'missing') request.headers['sec-websocket-protocol'] = '';
    if (kind === 'malformed') request.headers['sec-websocket-protocol'] = `visitor-session-token, ${randomBytes(32).toString('base64url')}`;
    if (kind === 'tampered') {
      const parts = request.headers['sec-websocket-protocol'].split('.');
      parts[1] = randomBytes(32).toString('base64url');
      request.headers['sec-websocket-protocol'] = parts.join('.');
    }
    upgrade(request, socket, head);
    expectRejected();
    expect(socket.write).toHaveBeenCalledWith('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
  });

  it('fails closed when the authentication secret is unavailable', () => {
    const { request } = authenticatedRequest(identifierUrl());
    delete process.env.VISITOR_SESSION_TOKEN_SECRET;
    upgrade(request, socket, head);
    expectRejected();
    expect(socket.write).toHaveBeenCalledWith('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
  });

  it.each([
    undefined, '/unknown', '/ws/', '/WS', '/%77s', '/api/agents/chat/websocket/',
    '//websocket.invalid/ws', 'http://websocket.invalid/ws', '/a/../ws', '/%2e/ws',
    '/\\websocket.invalid/ws', '/w\ts', '/ws\n', '/ws#fragment', '/ws?site_id=%GG',
  ])('fails closed for target %j despite otherwise valid authentication', target => {
    const { request } = authenticatedRequest(identifierUrl());
    upgrade({ ...request, url: target }, socket, head);
    expectRejected();
    expect(socket.write).not.toHaveBeenCalled();
  });
});