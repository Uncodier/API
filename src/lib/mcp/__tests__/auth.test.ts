import { afterEach, beforeAll, beforeEach, expect, it, jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';

const validateApiKey = jest.fn<(key: string) => Promise<{ isValid: boolean }>>();
jest.unstable_mockModule('@/lib/services/api-keys/ApiKeyService', () => ({ ApiKeyService: { validateApiKey } }));
let auth: typeof import('../auth');
const saved = process.env.SERVICE_API_KEY;
const request = (headers: Record<string, string> = {}) => new Request('https://api.example.invalid/api/mcp', { headers });
beforeAll(async () => { auth = await import('../auth'); });
beforeEach(() => { validateApiKey.mockReset().mockResolvedValue({ isValid: false }); delete process.env.SERVICE_API_KEY; });
afterEach(() => { if (saved === undefined) delete process.env.SERVICE_API_KEY; else process.env.SERVICE_API_KEY = saved; });

it.each(['Basic', 'Digest', 'Token', 'bearer'])('ignores unsupported %s scheme', scheme => {
  expect(auth.getApiKeyFromRequest(request({ authorization: `${scheme} ${randomBytes(24).toString('hex')}` }))).toBeNull();
});
it('extracts trimmed headers and prioritizes x-api-key', () => {
  const key = randomBytes(24).toString('hex'); const other = randomBytes(24).toString('hex');
  expect(auth.getApiKeyFromRequest(request({ authorization: `Bearer ${key} ` }))).toBe(key);
  expect(auth.getApiKeyFromRequest(request({ authorization: `Bearer ${other}`, 'x-api-key': ` ${key} ` }))).toBe(key);
});
it('rejects missing/empty credentials without a database call', async () => {
  const cases: Record<string, string>[] = [{}, { authorization: 'Bearer ' }, { 'x-api-key': ' ' }];
  for (const headers of cases) {
    expect(await auth.validateMcpApiKey(request(headers))).toBe(false);
  }
  expect(validateApiKey).not.toHaveBeenCalled();
});
it('validates service credentials without a database call', async () => {
  const key = randomBytes(32).toString('hex'); process.env.SERVICE_API_KEY = key;
  expect(await auth.validateMcpApiKey(request({ authorization: `Bearer ${key}` }))).toBe(true);
  expect(validateApiKey).not.toHaveBeenCalled();
});
it.each([true, false])('preserves database admission decision %s', async isValid => {
  const key = randomBytes(32).toString('hex'); validateApiKey.mockResolvedValue({ isValid });
  expect(await auth.validateMcpApiKey(request({ 'x-api-key': key }))).toBe(isValid);
  expect(validateApiKey).toHaveBeenCalledTimes(1);
  expect(validateApiKey).toHaveBeenCalledWith(key);
});
it('fails closed without exposing thrown database diagnostics', async () => {
  const secret = randomBytes(32).toString('hex');
  validateApiKey.mockRejectedValue(new Error(secret));
  expect(await auth.validateMcpApiKey(request({ 'x-api-key': randomBytes(32).toString('hex') }))).toBe(false);
  expect(validateApiKey).toHaveBeenCalledTimes(1);
});