import {
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';

const mockFrom: any = jest.fn();
const mockGetCachedJson: any = jest.fn();
const mockSetCachedJson = jest.fn(async () => true);

jest.mock('@/lib/database/supabase-client', () => ({
  supabase: { from: mockFrom },
  supabaseAdmin: { from: mockFrom },
}));
jest.mock('@/lib/security/upstash-rest', () => ({
  getCachedJson: mockGetCachedJson,
  setCachedJson: mockSetCachedJson,
  sha256: jest.fn(async () => 'lookup-hash'),
}));

import { ApiKeyService } from '../ApiKeyService';

const originalEncryptionKey = process.env.ENCRYPTION_KEY;

function queryResult(result: unknown) {
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'is', 'limit', 'update']) {
    builder[method] = jest.fn(() => builder);
  }
  builder.then = (
    resolve: (value: unknown) => unknown,
    reject: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  return builder;
}

describe('ApiKeyService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENCRYPTION_KEY = 'test_encryption_key_32_bytes_length!!';
    mockGetCachedJson.mockResolvedValue(null);
  });

  afterAll(() => {
    if (originalEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = originalEncryptionKey;
  });

  it('generates unique API keys with the requested prefix', () => {
    const first = ApiKeyService.generateApiKey('test');
    const second = ApiKeyService.generateApiKey('test');
    expect(first).toMatch(/^test_[A-Za-z0-9_-]+$/);
    expect(second).not.toBe(first);
  });

  it('round-trips encrypted API keys', async () => {
    const apiKey = ApiKeyService.generateApiKey();
    const encrypted = await (ApiKeyService as any).encryptApiKey(apiKey);
    await expect((ApiKeyService as any).decryptApiKey(encrypted))
      .resolves.toBe(apiKey);
  });

  it('rejects encryption without the encryption key', async () => {
    delete process.env.ENCRYPTION_KEY;
    await expect((ApiKeyService as any).encryptApiKey('test_key'))
      .rejects.toThrow('Missing ENCRYPTION_KEY');
  });

  it('uses the indexed lookup hash and never exposes encrypted key material', async () => {
    const apiKey = 'test_valid-key';
    const activeKey = {
      id: 'key-id',
      name: 'Test key',
      key_hash: 'encrypted',
      prefix: 'test',
      user_id: 'user-id',
      site_id: 'site-id',
      scopes: ['read'],
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      metadata: {},
      status: 'active',
    };
    mockFrom
      .mockReturnValueOnce(queryResult({ data: [activeKey], error: null }))
      .mockReturnValueOnce(queryResult({ data: null, error: null }));
    jest.spyOn(ApiKeyService as any, 'decryptApiKey')
      .mockResolvedValue(apiKey);

    const result = await ApiKeyService.validateApiKey(apiKey);

    expect(result.isValid).toBe(true);
    expect(result.keyData).toMatchObject({ id: 'key-id', site_id: 'site-id' });
    expect(result.keyData).not.toHaveProperty('key_hash');
    expect(mockSetCachedJson).toHaveBeenCalledWith(
      'auth:api-key:lookup-hash',
      expect.objectContaining({ isValid: true }),
      60,
    );
  });
});
