import { randomBytes, randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { ApiKeyService } from '@/lib/services/api-keys/ApiKeyService';
import { canToolPrincipalAccessSite, resolveToolRequestPrincipal } from '../tool-request-principal';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { auth: { getUser: jest.fn() }, rpc: jest.fn() } }));
jest.mock('@/lib/services/api-keys/ApiKeyService', () => ({ ApiKeyService: { validateApiKey: jest.fn() } }));
const userId = randomUUID(); const siteId = randomUUID();
const originalServiceKey = process.env.SERVICE_API_KEY;
beforeEach(() => { jest.clearAllMocks(); process.env.SERVICE_API_KEY = randomBytes(32).toString('hex'); });
afterAll(() => { if (originalServiceKey === undefined) delete process.env.SERVICE_API_KEY; else process.env.SERVICE_API_KEY = originalServiceKey; });
const request = (headers: Record<string, string>) => new Request('https://api.example.test/api/mcp', { headers });

it('does not authenticate forged metadata or non-Bearer schemes', async () => {
  expect(await resolveToolRequestPrincipal(request({ 'x-auth-user-id': userId, 'x-auth-validated': 'true',
    'x-api-key-data': JSON.stringify({ isService: true, user_id: userId }) }))).toBeNull();
  expect(await resolveToolRequestPrincipal(request({ authorization: `Basic ${randomBytes(32).toString('hex')}` }))).toBeNull();
});
it('recognizes the actual service credential, not identity assertions', async () => {
  expect(await resolveToolRequestPrincipal(request({ 'x-api-key': process.env.SERVICE_API_KEY! })))
    .toEqual({ internal: true, userId: null, siteId: null });
});
it('uses the verified JWT actor instead of the claimed actor', async () => {
  const credential = Array.from({ length: 3 }, () => randomBytes(16).toString('base64url')).join('.');
  (supabaseAdmin.auth.getUser as jest.Mock).mockResolvedValue({ data: { user: { id: userId } }, error: null });
  expect(await resolveToolRequestPrincipal(request({ authorization: `Bearer ${credential}`, 'x-auth-user-id': randomUUID() })))
    .toEqual({ internal: false, userId, siteId: null });
  expect(supabaseAdmin.auth.getUser).toHaveBeenCalledWith(credential);
});
it('binds DB API keys to their own user and site and respects key precedence', async () => {
  const key = randomBytes(32).toString('hex');
  (ApiKeyService.validateApiKey as jest.Mock).mockResolvedValue({ isValid: true, keyData: { user_id: userId, site_id: siteId } });
  expect(await resolveToolRequestPrincipal(request({ 'x-api-key': key, 'x-mcp-user-id': randomUUID(),
    authorization: `Bearer ${process.env.SERVICE_API_KEY}` }))).toEqual({ internal: false, userId, siteId });
  expect(ApiKeyService.validateApiKey).toHaveBeenCalledWith(key);
});
it('denies revoked keys, failed auth and missing actors', async () => {
  (ApiKeyService.validateApiKey as jest.Mock).mockResolvedValue({ isValid: false });
  expect(await resolveToolRequestPrincipal(request({ 'x-api-key': randomBytes(32).toString('hex') }))).toBeNull();
  (ApiKeyService.validateApiKey as jest.Mock).mockResolvedValue({ isValid: true });
  expect(await resolveToolRequestPrincipal(request({ 'x-api-key': randomBytes(32).toString('hex') }))).toBeNull();
});
it('does not let a tenant-bound key select another site, and checks current licensing', async () => {
  const principal = { internal: false, userId, siteId };
  expect(await canToolPrincipalAccessSite(principal, randomUUID())).toBe(false);
  expect(supabaseAdmin.rpc).not.toHaveBeenCalled();
  (supabaseAdmin.rpc as jest.Mock).mockReturnValue({ abortSignal: async () => ({ data: true, error: null }) });
  expect(await canToolPrincipalAccessSite(principal, siteId)).toBe(true);
  (supabaseAdmin.rpc as jest.Mock).mockReturnValue({ abortSignal: async () => ({ data: true, error: { message: 'failed' } }) });
  expect(await canToolPrincipalAccessSite(principal, siteId)).toBe(false);
});