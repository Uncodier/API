const mockFrom = jest.fn();
const mockGetAudienceById = jest.fn();
const mockGetAudiencePageForSending = jest.fn();
const mockUpdateAudienceLeadStatus = jest.fn();
const mockFindActiveSalesAgent = jest.fn();

jest.mock("@/lib/database/supabase-client", () => ({
  supabaseAdmin: { from: mockFrom },
}));
jest.mock("@/lib/database/audience-db", () => ({
  getAudienceById: mockGetAudienceById,
  getAudiencePageForSending: mockGetAudiencePageForSending,
  updateAudienceLeadStatus: mockUpdateAudienceLeadStatus,
}));
jest.mock("../sendEmail/route", () => ({ sendEmailCore: jest.fn() }));
jest.mock("@/lib/services/whatsapp/WhatsAppSendService", () => ({
  WhatsAppSendService: {},
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
        email: "ada@example.com",
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
    expect(conversationInsert).toHaveBeenCalledWith([
      expect.objectContaining({
        custom_data: expect.objectContaining({
          voice_objective: "Confirm Ada Lovelace's appointment",
          voice_additional_context: "Preferred time: afternoon.",
        }),
      }),
    ]);
    expect(messageInsert).toHaveBeenCalledWith([
      expect.objectContaining({
        custom_data: expect.objectContaining({
          voice_mode: "agent_call",
          voice_objective: "Confirm Ada Lovelace's appointment",
          voice_additional_context: "Preferred time: afternoon.",
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
});
