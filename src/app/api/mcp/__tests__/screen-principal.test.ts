import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { createMcpServer } from '@/lib/mcp/server';
import { canToolPrincipalAccessSite, resolveToolRequestPrincipal } from '@/lib/security/tool-request-principal';
import { POST } from '../route';

jest.mock('@/lib/mcp/server', () => ({ createMcpServer: jest.fn(() => ({ connect: jest.fn() })) }));
jest.mock('@/lib/security/tool-request-principal', () => ({ canToolPrincipalAccessSite: jest.fn(), resolveToolRequestPrincipal: jest.fn() }));
jest.mock('@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js', () => ({
  WebStandardStreamableHTTPServerTransport: jest.fn(() => ({ handleRequest: async () => new Response('{}') })),
}));
const siteId = randomUUID(); const userId = randomUUID();
const request = () => new NextRequest('https://api.example.test/api/mcp', {
  method: 'POST', headers: { 'x-mcp-site-id': siteId, 'x-mcp-user-id': randomUUID() }, body: '{}',
});
beforeEach(() => { jest.clearAllMocks(); (canToolPrincipalAccessSite as jest.Mock).mockResolvedValue(true); });
it('ignores claimed MCP user identity for a non-service key', async () => {
  (resolveToolRequestPrincipal as jest.Mock).mockResolvedValue({ internal: false, userId, siteId });
  expect((await POST(request())).status).toBe(200);
  expect(createMcpServer).toHaveBeenCalledWith(siteId, userId, 'default');
});
it('rejects cross-site keys before constructing a server or listing tools', async () => {
  (resolveToolRequestPrincipal as jest.Mock).mockResolvedValue({ internal: false, userId, siteId: randomUUID() });
  (canToolPrincipalAccessSite as jest.Mock).mockResolvedValue(false);
  expect((await POST(request())).status).toBe(403);
  expect(createMcpServer).not.toHaveBeenCalled();
});
it('requires authentication even when identity/context headers are present', async () => {
  (resolveToolRequestPrincipal as jest.Mock).mockResolvedValue(null);
  expect((await POST(request())).status).toBe(401);
  expect(createMcpServer).not.toHaveBeenCalled();
});