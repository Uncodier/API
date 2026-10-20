import { createHmac, randomBytes } from 'node:crypto';
import { NextRequest } from 'next/server';

const mockRpc = jest.fn();
const mockFrom = jest.fn();
const mockExecute = jest.fn();
const mockIdentify = jest.fn();
const mockGetCall = jest.fn();
const mockFindLead = jest.fn();
let mockSecret: string;
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { rpc: mockRpc } }));
jest.mock('@/lib/database/supabase-server', () => ({
  getSupabaseAdmin: () => ({ from: mockFrom }), supabaseAdmin: { schema: () => ({ from: mockFrom }) },
}));
jest.mock('@/lib/utils/token-decryption', () => ({ decryptToken: () => mockSecret }));
jest.mock('../voice-tool-catalog', () => ({ getCustomerSupportVoiceToolDefinitions: () => [
  { name: 'catalog', parameters: { type: 'object', properties: {} }, execute: mockExecute },
  { name: 'GET_TASKS', parameters: { type: 'object', properties: {} } },
  { name: 'IDENTIFY_LEAD', parameters: { type: 'object', properties: {} } },
  { name: 'get_call_context', parameters: { type: 'object', properties: {} } },
  { name: 'CONTACT_HUMAN', parameters: { type: 'object', properties: {} } },
  { name: 'scoped', parameters: { type: 'object', properties: { lead_id: { type: 'string' } } }, execute: mockExecute },
] }));
jest.mock('../voice-lead-identification', () => ({
  identifyVoiceLead: mockIdentify, normalizeVoiceIdentityPhone: (value: string) => value,
}));
jest.mock('../inbound-voice-lead', () => ({ findInboundVoiceLead: mockFindLead }));
jest.mock('../voice-call-client', () => ({ getVoiceCall: mockGetCall }));
jest.mock('@/lib/agentbase/agents/toolEvaluator/executor/customToolsMap', () => ({ getCustomToolDefinition: jest.fn() }));

import { POST } from '@/app/api/integrations/zavu/voice-tools/route';
const SITE = '11111111-1111-4111-8111-111111111111';
const voice = { id: 'voice-1', type: 'voice', status: 'active', enabled: true,
  license_suspended: false, zavu_sender_id: 'sender-1' };

describe('signed Voice tool callback manual-disabled enforcement', () => {
  let connections: Record<string, any>[];
  let fetchSpy: jest.SpyInstance;
  beforeEach(() => {
    jest.clearAllMocks();
    mockSecret = randomBytes(32).toString('hex');
    connections = [{ ...voice }];
    mockExecute.mockResolvedValue({ success: true });
    mockRpc.mockImplementation(() => ({ abortSignal: async () => ({ data: {
      effective_plan: 'engine', social_media: [], channels: { connections },
    }, error: null }) }));
    const q: any = { select: () => q, eq: () => q, order: () => q, limit: () => q,
      maybeSingle: async () => ({ data: { configuration: { zavu: { tool_webhook_secret: 'offline-fixture' } } }, error: null }) };
    mockFrom.mockReturnValue(q);
    fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('No live calls'));
    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());
  const request = (tool: string, signed = true) => {
    const body = JSON.stringify({ tool, arguments: {}, context: { contactPhone: '+13015550100' } });
    return new NextRequest(`https://api.example.test/api/integrations/zavu/voice-tools?siteId=${SITE}`, {
      method: 'POST', body, headers: signed
        ? { 'x-zavu-signature': createHmac('sha256', mockSecret).update(body).digest('hex') } : {},
    });
  };

  it.each(['catalog', 'GET_TASKS', 'IDENTIFY_LEAD', 'get_call_context', 'CONTACT_HUMAN'])(
    'denies %s before native/API execution or provider reads', async tool => {
      connections[0]._license = { manually_disabled: true };
      const response = await POST(request(tool));
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ success: false, code: 'RESOURCE_LICENSE_UNAVAILABLE' });
      expect(mockExecute).not.toHaveBeenCalled();
      expect(mockIdentify).not.toHaveBeenCalled();
      expect(mockGetCall).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );
  it('admits enabled Voice and refreshes the exact connection before execution', async () => {
    expect((await POST(request('catalog'))).status).toBe(200);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledTimes(2);
  });
  it('denies mixed senders because the callback does not identify which sender is calling', async () => {
    connections.push({ ...voice, id: 'voice-2', zavu_sender_id: 'sender-2', enabled: false });
    expect((await POST(request('catalog'))).status).toBe(403);
    expect(mockExecute).not.toHaveBeenCalled();
  });
  it('stops execution when disabled during argument preparation', async () => {
    mockFindLead.mockImplementationOnce(async () => {
      connections[0]._license = { manually_disabled: true };
      return undefined;
    });
    expect((await POST(request('scoped'))).status).toBe(403);
    expect(mockExecute).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('never consults licenses or executes for an unsigned callback', async () => {
    expect((await POST(request('catalog', false))).status).toBe(401);
    expect(mockRpc).not.toHaveBeenCalled();
  });
  it('returns safe retryable projection-unavailable errors', async () => {
    mockRpc.mockImplementation(() => ({ abortSignal: async () => ({ data: null, error: { message: 'private' } }) }));
    const response = await POST(request('catalog'));
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain('private');
    expect(mockExecute).not.toHaveBeenCalled();
  });
});