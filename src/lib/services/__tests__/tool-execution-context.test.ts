import { randomBytes, randomUUID } from 'node:crypto';
import {
  buildToolExecutionContext,
  readToolExecutionContext,
  sanitizeToolContextText,
  TOOL_CONTEXT_MAX_JSON_BYTES,
} from '../tool-execution-context';

const siteId = randomUUID();

describe('private tool execution context', () => {
  it('selects only the versioned whitelist and valid optional references without mutating input', () => {
    const instance = randomUUID();
    const input = {
      version: 1, site_id: siteId, intent: '  Confirm the appointment  ',
      background: 'Verify availability first', history: ['private history'],
      systemPrompt: 'private system', toolOverrides: { secret: 'not included' },
      source: { tool: 'publish', instance_id: instance, node_id: 'not-a-uuid',
        conversation_id: randomUUID(), message_id: randomUUID(), content_id: randomUUID(),
        audience_id: randomUUID(), lead_id: randomUUID(), arbitrary: 'ignored' },
    };
    const before = JSON.stringify(input);
    const result = readToolExecutionContext(input, siteId)!;
    expect(result.intent).toBe('Confirm the appointment');
    expect(result.source).toEqual({ tool: 'publish', instance_id: instance,
      conversation_id: input.source.conversation_id, message_id: input.source.message_id,
      content_id: input.source.content_id, audience_id: input.source.audience_id });
    expect(Object.keys(result).sort()).toEqual(['background', 'intent', 'site_id', 'source', 'version']);
    expect(JSON.stringify(input)).toBe(before);
    expect(result.source).not.toBe(input.source);
  });

  it.each([null, [], 'text', { version: 2, site_id: siteId, source: {} },
    { version: 1, site_id: randomUUID(), source: {} },
    { version: 1, site_id: siteId, source: [] },
    { version: 1, site_id: siteId }])('rejects invalid or foreign tenant envelopes: %j', value => {
    expect(readToolExecutionContext(value, siteId)).toBeUndefined();
  });

  it('never serializes unknown objects or their custom toJSON methods', () => {
    const toJSON = jest.fn(() => { throw new Error('must not serialize'); });
    const result = readToolExecutionContext({ version: 1, site_id: siteId,
      source: { tool: 'invalid tool' }, intent: { toJSON }, background: ['history'], unknown: { toJSON } }, siteId);
    expect(result).toEqual({ version: 1, site_id: siteId, source: {} });
    expect(toJSON).not.toHaveBeenCalled();
  });

  it.each(['http:', 'https:'])('removes URL userinfo before email redaction for %s', protocol => {
    const username = randomBytes(18).toString('hex');
    const password = randomBytes(24).toString('hex');
    const token = randomBytes(24).toString('hex');
    const address = `${randomBytes(12).toString('hex')}@example.invalid`;
    const url = new URL(`${protocol}//example.invalid/private`);
    url.username = username;
    url.password = password;
    url.searchParams.set('token', token);
    const result = sanitizeToolContextText(`${url.href}\nContact ${address}`, 4_000)!;
    expect(result).toContain('example.invalid/private');
    for (const sensitive of [username, password, token, address]) expect(result).not.toContain(sensitive);
  });

  it('redacts secrets and email addresses across a truncation boundary before slicing', () => {
    const password = randomBytes(100).toString('hex');
    const bearer = randomBytes(100).toString('hex');
    const address = `${randomBytes(40).toString('hex')}@example.invalid`;
    for (const [prefix, sensitive] of [['password=', password], ['Bearer ', bearer], ['', address]]) {
      const result = sanitizeToolContextText(`Useful request. ${prefix}${sensitive}`, 45)!;
      expect(result).toContain('Useful request.');
      expect(result).not.toContain(sensitive);
      expect(result).not.toContain(sensitive.slice(0, 12));
      expect(result.length).toBeLessThanOrEqual(45);
    }
  });

  it('redacts signed URL and API credential query values before truncation', () => {
    const url = new URL('https://example.invalid/asset');
    const credentials = ['X-Amz-Signature', 'X-Amz-Credential', 'X-Amz-Security-Token',
      'X-Goog-Signature', 'X-Goog-Credential', 'api_key', 'access_token', 'refresh_token']
      .map(key => ({ key, value: randomBytes(24).toString('hex') }));
    for (const credential of credentials) url.searchParams.set(credential.key, credential.value);
    for (const maxChars of [100, 4_000]) {
      const result = sanitizeToolContextText(url.href, maxChars)!;
      for (const credential of credentials) {
        expect(result).not.toContain(credential.value);
        expect(result).not.toContain(credential.value.slice(0, 12));
      }
    }
  });

  it('bounds intent, background, and the UTF-8 serialized JSON including escaping', () => {
    const ascii = buildToolExecutionContext({ site_id: siteId, intent: 'a'.repeat(9_000), background: 'b'.repeat(9_000) })!;
    expect(ascii.intent).toHaveLength(2_000);
    expect(ascii.background).toHaveLength(4_000);
    const multiByte = buildToolExecutionContext({ site_id: siteId,
      intent: '😀漢"\n'.repeat(3_000), background: '😀漢"\n'.repeat(3_000) })!;
    expect(multiByte.intent!.length).toBeLessThanOrEqual(2_000);
    expect(Buffer.byteLength(JSON.stringify(multiByte))).toBeLessThanOrEqual(TOOL_CONTEXT_MAX_JSON_BYTES);
    expect(readToolExecutionContext(multiByte, siteId)).toEqual(multiByte);
  });

  it('handles absent text, control characters and invalid budgets safely', () => {
    for (const value of [undefined, null, {}, [], 123, '  ']) {
      expect(sanitizeToolContextText(value, 10)).toBeUndefined();
    }
    for (const size of [-1, 0, NaN, Infinity]) expect(sanitizeToolContextText('text', size)).toBeUndefined();
    expect(sanitizeToolContextText('\u0000Useful\u007f', 50)).toBe('Useful');
    expect(buildToolExecutionContext({ site_id: 'invalid' })).toBeUndefined();
  });
});