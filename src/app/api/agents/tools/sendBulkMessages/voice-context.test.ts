const mockFrom = jest.fn();
const mockRpc = jest.fn();
const mockGetAudienceById = jest.fn();
const mockGetAudiencePageForSending = jest.fn();
const mockUpdateAudienceLeadStatus = jest.fn();
const mockFindActiveSalesAgent = jest.fn();

jest.mock("@/lib/database/supabase-client", () => ({
  supabaseAdmin: { from: mockFrom, rpc: mockRpc },
}));
jest.mock("@/lib/database/audience-db", () => ({
  getAudienceById: mockGetAudienceById,
  getAudiencePageForSending: mockGetAudiencePageForSending,
  updateAudienceLeadStatus: mockUpdateAudienceLeadStatus,
}));
// Voice queue preparation must not load or call actual email/WhatsApp dispatch adapters.
jest.mock("@/lib/messaging/exact-delivery", () => ({
  sendExactDelivery: jest.fn(() => { throw new Error('Unexpected direct delivery in a Voice queue test.'); }),
  getExactWhatsAppConfig: jest.fn(() => { throw new Error('Unexpected WhatsApp preparation in a Voice queue test.'); }),
}));
jest.mock("@/lib/services/whatsapp/WhatsAppTemplateService", () => ({
  WhatsAppTemplateService: {},
}));
jest.mock("./support", () => ({
  findActiveSalesAgent: mockFindActiveSalesAgent,
  resolvePlaceholderPolicy: jest.fn().mockResolvedValue("strip_tokens"),
  resolveNumberedTemplate: (value: string) => value,
}));

import { sendBulkMessagesTool } from "./assistantProtocol";

describe("sendBulkMessages Voice context", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRpc.mockImplementation((name: string, args: { p_site_id: string }) => {
      expect(name).toBe('get_site_licensed_resources');
      expect(args).toEqual({ p_site_id: 'site-1' });
      return { abortSignal: async (signal: AbortSignal) => {
        expect(signal).toBeInstanceOf(AbortSignal);
        return { data: { effective_plan: 'engine', social_media: [], channels: { connections: [{
          id: 'voice-1', type: 'voice', status: 'connected', license_suspended: false, zavu_sender_id: 'voice-sender-1',
        }] } }, error: null };
      } };
    });
    mockGetAudienceById.mockResolvedValue({
      id: "audience-1",
      site_id: "site-1",
      status: "ready",
      total_count: 1,
      page_size: 100,
    });
    mockGetAudiencePageForSending.mockResolvedValue({
      leads: [{
        id: "lead-1",
        name: "Ada Lovelace",
        email: "ada@example.invalid",
        phone: "+14155550100",
        do_not_call: false,
        voice_call_consent_status: "unknown",
        metadata: { preferred_slot: "afternoon" },
      }],
    });
    mockFindActiveSalesAgent.mockResolvedValue(null);
    mockUpdateAudienceLeadStatus.mockResolvedValue(undefined);
  });

  it("queues Voice with unknown consent and stores personalized private guidance", async () => {
    const conversationInsert = jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        single: jest.fn().mockResolvedValue({
          data: { id: "conversation-1" },
          error: null,
        }),
      }),
    });
    const messageInsert = jest.fn().mockResolvedValue({ error: null });
    mockFrom.mockImplementation((table: string) => {
      if (table === "sites") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: jest.fn().mockResolvedValue({
                data: { name: "Acme" },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "conversations") return { insert: conversationInsert };
      if (table === "messages") return { insert: messageInsert };
      throw new Error(`Unexpected table ${table}`);
    });

    const result = await sendBulkMessagesTool("site-1").execute({
      audience_id: "audience-1",
      channel: "voice",
      voice_mode: "agent_call",
      message: "Hello {{lead.first_name}}.",
      objective: "Confirm {{lead.name}}'s appointment",
      additional_context: "Preferred time: {{lead.metadata.preferred_slot}}.",
    });

    expect(result).toMatchObject({ success: true, total_sent: 1 });
    expect(mockRpc).toHaveBeenCalledWith('get_site_licensed_resources', { p_site_id: 'site-1' });
    expect(conversationInsert).toHaveBeenCalledWith([
      expect.objectContaining({
        custom_data: expect.objectContaining({
          voice_objective: "Confirm Ada Lovelace's appointment",
          voice_additional_context: "Preferred time: afternoon.",
          connection_id: 'voice-1',
        }),
      }),
    ]);
    expect(messageInsert).toHaveBeenCalledWith([
      expect.objectContaining({
        custom_data: expect.objectContaining({
          voice_mode: "agent_call",
          voice_objective: "Confirm Ada Lovelace's appointment",
          voice_additional_context: "Preferred time: afternoon.",
          connection_id: 'voice-1',
        }),
      }),
    ]);
  });

  it.each([
    { do_not_call: true, voice_call_consent_status: 'granted' },
    { voice_call_consent_status: 'revoked' },
    { voice_call_consent_status: 'denied' },
  ])('skips explicit call opt-outs before queueing: %j', async preferences => {
    mockGetAudiencePageForSending.mockResolvedValue({ leads: [{
      id: 'lead-1', name: 'Ada Lovelace', phone: '+14155550100', ...preferences,
    }] });
    mockFrom.mockImplementation((table: string) => {
      if (table !== 'sites') throw new Error(`Unexpected write to ${table}`);
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { name: 'Acme' }, error: null }) }) }) };
    });
    const result = await sendBulkMessagesTool('site-1').execute({
      audience_id: 'audience-1', channel: 'voice', voice_mode: 'agent_call', message: 'Hello Ada.',
    });
    expect(result).toMatchObject({ total_sent: 0, total_skipped: 1 });
    expect(mockUpdateAudienceLeadStatus).toHaveBeenCalledWith('audience-1', 'lead-1', 'skipped',
      preferences.do_not_call ? 'Lead is on the do-not-call list' : 'Lead has opted out of Voice calls');
    expect(mockFrom.mock.calls.map(([table]) => table)).not.toContain('conversations');
    expect(mockFrom.mock.calls.map(([table]) => table)).not.toContain('messages');
  });
  it('denies an unavailable license projection before reading recipients or queueing Voice', async () => {
    mockRpc.mockReturnValue({ abortSignal: async () => ({ data: null, error: { code: 'PGRST202' } }) });
    const result = await sendBulkMessagesTool('site-1').execute({
      audience_id: 'audience-1', channel: 'voice', voice_mode: 'agent_call', message: 'Hello Ada.',
    });
    expect(result.success).toBe(false);
    expect(mockGetAudiencePageForSending).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockUpdateAudienceLeadStatus).not.toHaveBeenCalled();
  });
});
