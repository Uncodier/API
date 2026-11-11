import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { POST } from '../route';
import { createAssetCore } from '../core';
import { canToolPrincipalAccessSite, resolveToolRequestPrincipal } from '@/lib/security/tool-request-principal';

jest.mock('../core', () => ({ createAssetCore: jest.fn() }));
jest.mock('@/lib/security/tool-request-principal', () => ({
  canToolPrincipalAccessSite: jest.fn(), resolveToolRequestPrincipal: jest.fn(),
}));
const siteId = randomUUID();
const request = () => new NextRequest('https://api.example.test/api/agents/tools/assets/create', {
  method: 'POST', body: JSON.stringify({ site_id: siteId }),
});
beforeEach(() => jest.clearAllMocks());
it('rejects unauthenticated requests without creating assets', async () => {
  (resolveToolRequestPrincipal as jest.Mock).mockResolvedValue(null);
  expect((await POST(request())).status).toBe(401);
  expect(createAssetCore).not.toHaveBeenCalled();
});
it('rejects principals without site access', async () => {
  (resolveToolRequestPrincipal as jest.Mock).mockResolvedValue({ internal: false, userId: randomUUID(), siteId });
  (canToolPrincipalAccessSite as jest.Mock).mockResolvedValue(false);
  expect((await POST(request())).status).toBe(403);
  expect(createAssetCore).not.toHaveBeenCalled();
});
it('creates only after authenticated site admission', async () => {
  (resolveToolRequestPrincipal as jest.Mock).mockResolvedValue({ internal: true, userId: null, siteId: null });
  (canToolPrincipalAccessSite as jest.Mock).mockResolvedValue(true);
  (createAssetCore as jest.Mock).mockResolvedValue({ id: randomUUID() });
  expect((await POST(request())).status).toBe(201);
});