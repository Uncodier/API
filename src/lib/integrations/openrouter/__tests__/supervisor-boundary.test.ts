const principal = jest.fn();
const access = jest.fn();
const from = jest.fn();
const getCommand = jest.fn();
const analyze = jest.fn();
jest.mock('@/lib/security/tool-request-principal', () => ({ resolveToolRequestPrincipal: principal, canToolPrincipalAccessSite: access }));
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from } }));
jest.mock('@/lib/agentbase', () => ({
  SupervisorService: jest.fn(() => ({ analyzeCommand: analyze })),
  ProcessorInitializer: { getInstance: () => ({ initialize: jest.fn(), getCommandService: () => ({ getCommandById: getCommand }) }) },
}));
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/agents/supervisor/route';
const site = '11111111-1111-4111-8111-111111111111';
const commandId = '22222222-2222-4222-8222-222222222222';
const conversationId = '33333333-3333-4333-8333-333333333333';
function request(body: unknown = { command_id: commandId }) {
  return new NextRequest('https://api.example.test/api/agents/supervisor', { method: 'POST', body: JSON.stringify(body) });
}
beforeEach(() => {
  jest.clearAllMocks();
  principal.mockResolvedValue({ internal: false, userId: 'actor', siteId: site });
  access.mockResolvedValue(true);
  from.mockImplementation(() => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { site_id: site }, error: null }) }) }) }));
  getCommand.mockResolvedValue({ id: commandId, site_id: site, results: [] });
  analyze.mockResolvedValue({ success: true });
});
it('rejects unauthenticated victim IDs before command storage', async () => {
  principal.mockResolvedValue(null);
  expect((await POST(request())).status).toBe(401);
  expect(from).not.toHaveBeenCalled();
  expect(getCommand).not.toHaveBeenCalled();
  expect(analyze).not.toHaveBeenCalled();
});
it('rejects malformed IDs before command storage', async () => {
  expect((await POST(request({ command_id: 'invalid' }))).status).toBe(400);
  expect(from).not.toHaveBeenCalled();
});
it('rejects a cross-site command before loading its contents or payer', async () => {
  access.mockResolvedValue(false);
  expect((await POST(request())).status).toBe(403);
  expect(getCommand).not.toHaveBeenCalled();
  expect(analyze).not.toHaveBeenCalled();
});
it.each(['explicit', 'context', 'results'])('rejects cross-site %s conversations before inference or writes', async source => {
  from.mockImplementation((table: string) => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({
    data: { site_id: table === 'commands' ? site : 'other-site' }, error: null,
  }) }) }) }));
  getCommand.mockResolvedValue({ id: commandId, site_id: site,
    context: source === 'context' ? `conversation_id: ${conversationId}` : '',
    results: source === 'results' ? [{ custom_data: { conversation_id: conversationId } }] : [],
  });
  const response = await POST(request({ command_id: commandId, ...(source === 'explicit' ? { conversation_id: conversationId } : {}) }));
  expect(response.status).toBe(403);
  expect(analyze).not.toHaveBeenCalled();
  expect(from.mock.calls.every(([table]) => ['commands', 'conversations'].includes(table))).toBe(true);
});
it('allows authorized command and same-site conversation', async () => {
  expect((await POST(request({ command_id: commandId, conversation_id: conversationId }))).status).toBe(200);
  expect(analyze).toHaveBeenCalledWith(expect.objectContaining({ id: commandId }), conversationId);
});
it('fails closed on authorization storage errors', async () => {
  from.mockImplementation(() => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ error: new Error('offline') }) }) }) }));
  expect((await POST(request())).status).toBe(503);
  expect(analyze).not.toHaveBeenCalled();
});