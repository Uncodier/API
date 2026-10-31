import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { randomBytes, randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import { invokeRemoteTool, RemoteToolError, shouldUseRemoteApi } from '../remote-client';

const credential = () => randomBytes(24).toString('hex');
const presence = ['missing', 'empty', 'present'] as const;
type Presence = typeof presence[number];

function setEnv(name: string, state: Presence, value: string) {
  if (state === 'missing') delete process.env[name];
  else process.env[name] = state === 'empty' ? '' : value;
}

describe('remote tool client (offline)', () => {
  let request: jest.SpiedFunction<typeof fetch>;
  let log: jest.SpiedFunction<typeof console.log>;
  let info: jest.SpiedFunction<typeof console.info>;
  let warn: jest.SpiedFunction<typeof console.warn>;
  let stderr: jest.SpiedFunction<typeof console.error>;
  let stdout: jest.SpiedFunction<typeof process.stdout.write>;

  beforeEach(() => {
    // Replace, rather than merge, the environment: no developer credentials or
    // setup-file defaults can influence mode selection or request headers.
    jest.replaceProperty(process, 'env', { NODE_ENV: 'test' });
    request = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected mocked fetch'));
    log = jest.spyOn(console, 'log').mockImplementation(() => {});
    info = jest.spyOn(console, 'info').mockImplementation(() => {});
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    stderr = jest.spyOn(console, 'error').mockImplementation(() => {});
    stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    try {
      // Every branch must leave the MCP protocol channel untouched.
      expect(log).not.toHaveBeenCalled();
      expect(info).not.toHaveBeenCalled();
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      jest.restoreAllMocks();
    }
  });

  function diagnostics() {
    return inspect([log.mock.calls, info.mock.calls, warn.mock.calls, stderr.mock.calls]);
  }

  function sensitiveFixture() {
    const username = credential();
    const password = credential();
    const query = credential();
    const fragment = credential();
    const key = credential();
    const payloadValue = credential();
    const upstreamValue = credential();
    const url = new URL('https://example.invalid/base/');
    url.username = username;
    url.password = password;
    url.searchParams.set('token', query);
    url.hash = fragment;
    process.env.API_URL = url.href;
    process.env.REST_API_KEY = key;
    const values = [username, password, query, fragment, key, payloadValue, upstreamValue];
    return { values, payload: { private: payloadValue }, diagnostic: `${url.href} Authorization: Bearer ${key}\n${payloadValue}\n${upstreamValue}` };
  }

  function expectSafe(error: Error | undefined, values: string[]) {
    const diagnosticText = diagnostics();
    for (const value of values) {
      expect(diagnosticText).not.toContain(value);
      if (error) {
        expect(error.message).not.toContain(value);
        expect(error.stack).not.toContain(value);
      }
    }
    if (error) expect(error).not.toHaveProperty('cause');
  }

  async function failure(payload: unknown = {}) {
    try {
      await invokeRemoteTool('/api/tool', payload);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      return error as Error;
    }
    throw new Error('Expected remote invocation to fail');
  }

  describe('mode selection', () => {
    const cases = presence.flatMap(db => presence.flatMap(api => presence.map(key => ({ db, api, key }))));
    it.each(cases)('DB=$db API=$api REST=$key', ({ db, api, key }) => {
      setEnv('SUPABASE_SERVICE_ROLE_KEY', db, credential());
      setEnv('API_URL', api, 'https://example.invalid');
      setEnv('REST_API_KEY', key, credential());
      // Public Supabase credentials are not service-role credentials.
      process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.invalid';
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = credential();
      expect(shouldUseRemoteApi()).toBe(db !== 'present' && api === 'present');
      expect(request).not.toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalled();
    });

    it('reads mode dynamically instead of caching environment at import time', () => {
      expect(shouldUseRemoteApi()).toBe(false);
      process.env.API_URL = 'https://example.invalid';
      expect(shouldUseRemoteApi()).toBe(true);
      process.env.SUPABASE_SERVICE_ROLE_KEY = credential();
      expect(shouldUseRemoteApi()).toBe(false);
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      expect(shouldUseRemoteApi()).toBe(true);
    });
  });

  describe('request construction and success', () => {
    it.each([
      ['https://example.invalid', 'api/tool', 'https://example.invalid/api/tool'],
      ['https://example.invalid/', '/api/tool', 'https://example.invalid/api/tool'],
      ['https://example.invalid///', '///api/tool', 'https://example.invalid/api/tool'],
      ['https://example.invalid/base', '/api/tool', 'https://example.invalid/base/api/tool'],
      ['https://example.invalid/base///', 'api/tool', 'https://example.invalid/base/api/tool'],
      ['https://example.invalid', '', 'https://example.invalid/'],
      ['https://example.invalid/', '/', 'https://example.invalid/'],
      ['https://example.invalid/', '/api/tool?limit=1', 'https://example.invalid/api/tool?limit=1'],
    ])('joins %s and %s', async (base, path, expected) => {
      process.env.API_URL = base;
      request.mockResolvedValue(new Response('{"success":true}'));
      const payload = { filter: ['one', 'two'], nested: { enabled: true }, optional: null };
      await expect(invokeRemoteTool(path, payload)).resolves.toEqual({ success: true });
      expect(request).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledWith(expected, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
    });

    it.each(presence.flatMap(key => presence.map(site => ({ key, site }))))(
      'auth=$key site=$site', async ({ key, site }) => {
        const apiKey = credential();
        const siteId = randomUUID();
        process.env.API_URL = 'https://example.invalid';
        setEnv('REST_API_KEY', key, apiKey);
        setEnv('MCP_SITE_ID', site, siteId);
        request.mockResolvedValue(new Response('{}'));
        await invokeRemoteTool('/api/tool', {});
        const headers = new Headers(request.mock.calls[0][1]?.headers);
        expect(headers.get('content-type')).toBe('application/json');
        expect(headers.get('x-api-key')).toBe(key === 'present' ? apiKey : null);
        expect(headers.get('authorization')).toBe(key === 'present' ? `Bearer ${apiKey}` : null);
        expect(headers.get('x-mcp-site-id')).toBe(site === 'present' ? siteId : null);
        expect([...headers.keys()]).toHaveLength(1 + (key === 'present' ? 2 : 0) + (site === 'present' ? 1 : 0));
        expect(request).toHaveBeenCalledTimes(1);
        expectSafe(undefined, [apiKey, siteId]);
      },
    );

    it.each([null, false, 0, 'result', [1, 2], { result: { success: true } }])(
      'returns successful JSON unchanged: %j', async result => {
        process.env.API_URL = 'https://example.invalid';
        request.mockResolvedValue(new Response(JSON.stringify(result)));
        await expect(invokeRemoteTool('/api/tool', {})).resolves.toEqual(result);
        expect(request).toHaveBeenCalledTimes(1);
      },
    );

    it('does not expose sensitive request or successful response data in diagnostics', async () => {
      const fixture = sensitiveFixture();
      request.mockResolvedValue(new Response(JSON.stringify({ result: fixture.diagnostic })));
      await expect(invokeRemoteTool('/api/tool', fixture.payload)).resolves.toEqual({ result: fixture.diagnostic });
      expectSafe(undefined, fixture.values);
      expect(request).toHaveBeenCalledTimes(1);
    });
  });

  describe('HTTP errors and consumer compatibility', () => {
    it('retains the public RemoteToolError constructor contract', () => {
      const data = { success: false, code: 'conflict' };
      const error = new RemoteToolError('Remote error 409', 409, data);
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('RemoteToolError');
      expect(error.message).toBe('Remote error 409');
      expect(error.status).toBe(409);
      expect(error.data).toBe(data);
    });

    it.each([
      { error: 'Denied', details: { code: 'forbidden' } },
      { message: 'Missing', success: false },
      { error: { message: 'Nested error' } },
      { error: '', message: 'Fallback' },
      {}, null, false, 0, 'upstream string', ['upstream array'],
    ])('preserves JSON error data without assuming its shape: %j', async data => {
      process.env.API_URL = 'https://example.invalid';
      const response = new Response(JSON.stringify(data), { status: 422 });
      const read = jest.spyOn(response, 'text');
      request.mockResolvedValue(response);
      const error = await failure();
      expect(error).toBeInstanceOf(RemoteToolError);
      expect(error).toMatchObject({ name: 'RemoteToolError', message: 'Remote error 422', status: 422, data });
      expect(read).toHaveBeenCalledTimes(1);
      expect(response.bodyUsed).toBe(true);
      expect(request).toHaveBeenCalledTimes(1);
    });

    it.each(['<html>Bad gateway</html>', 'not JSON', '{broken', ''])('handles non-JSON body %j with one read', async text => {
      process.env.API_URL = 'https://example.invalid';
      // Real Response enforces body consumption; a json/text stub would hide
      // the original fallback defect.
      const response = new Response(text, { status: 502 });
      const read = jest.spyOn(response, 'text');
      request.mockResolvedValue(response);
      const error = await failure();
      expect(error).toBeInstanceOf(RemoteToolError);
      expect(error).toMatchObject({ message: 'Remote error 502', status: 502, data: { error: text || 'Remote error 502' } });
      expect(read).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledTimes(1);
    });

    it.each([400, 401, 403, 404, 409, 429, 500, 503])('does not retry status %i (including transient failures)', async status => {
      process.env.API_URL = 'https://example.invalid';
      request.mockResolvedValue(new Response('{}', { status }));
      expect(await failure()).toMatchObject({ status, data: {} });
      expect(request).toHaveBeenCalledTimes(1);
    });

    it.each(['JSON', 'text'])('keeps %s upstream data for routes but excludes it from message/stack/logs', async format => {
      const fixture = sensitiveFixture();
      const data = { error: fixture.diagnostic, details: fixture.payload };
      request.mockResolvedValue(new Response(format === 'JSON' ? JSON.stringify(data) : fixture.diagnostic, { status: 403 }));
      const error = await failure(fixture.payload);
      expect(error).toBeInstanceOf(RemoteToolError);
      expect(error).toMatchObject({ status: 403, message: 'Remote error 403', data: format === 'JSON' ? data : { error: fixture.diagnostic } });
      expectSafe(error, fixture.values);
      expect(request).toHaveBeenCalledTimes(1);
    });
  });

  describe('configuration, transport, and parsing failures', () => {
    it.each(['missing', 'empty'] as const)('rejects %s API_URL before fetching', async state => {
      setEnv('API_URL', state, 'https://example.invalid');
      expect(await failure()).toMatchObject({ message: 'API_URL is required for remote tool invocation (Remote Mode)' });
      expect(request).not.toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalled();
    });

    it.each(['error', 'string', 'object', 'abort', 'sync'])('sanitizes %s fetch failure without retry or cause', async kind => {
      const fixture = sensitiveFixture();
      const thrown = kind === 'string' ? fixture.diagnostic
        : kind === 'object' ? { message: fixture.diagnostic, headers: { authorization: process.env.REST_API_KEY } }
          : kind === 'abort' ? new DOMException(fixture.diagnostic, 'AbortError') : new Error(fixture.diagnostic);
      if (kind === 'sync') request.mockImplementation(() => { throw thrown; });
      else request.mockRejectedValue(thrown);
      const error = await failure(fixture.payload);
      expect(error).not.toBeInstanceOf(RemoteToolError);
      expect(error.message).toBe('Remote tool invocation failed');
      expect(inspect(error)).not.toContain(fixture.diagnostic);
      expectSafe(error, fixture.values);
      expect(request).toHaveBeenCalledTimes(1);
    });

    it.each([200, 204])('sanitizes invalid/empty success JSON for status %i', async status => {
      const fixture = sensitiveFixture();
      request.mockResolvedValue(new Response(status === 204 ? null : fixture.diagnostic, { status }));
      const error = await failure(fixture.payload);
      expect(error.message).toBe('Remote tool invocation failed');
      expect(error).not.toBeInstanceOf(RemoteToolError);
      expectSafe(error, fixture.values);
      expect(request).toHaveBeenCalledTimes(1);
    });

    it('sanitizes an HTTP error body read failure without a second request', async () => {
      const fixture = sensitiveFixture();
      const response = new Response(null, { status: 500 });
      const read = jest.spyOn(response, 'text').mockRejectedValue(new Error(fixture.diagnostic));
      request.mockResolvedValue(response);
      const error = await failure(fixture.payload);
      expect(error.message).toBe('Remote tool invocation failed');
      expectSafe(error, fixture.values);
      expect(read).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledTimes(1);
    });

    it('sanitizes serialization failures before fetch', async () => {
      const fixture = sensitiveFixture();
      const payload = { toJSON() { throw new Error(fixture.diagnostic); } };
      const error = await failure(payload);
      expect(error.message).toBe('Remote tool invocation failed');
      expectSafe(error, fixture.values);
      expect(request).not.toHaveBeenCalled();
    });
  });
});