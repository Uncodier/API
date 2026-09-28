const mockFrom = jest.fn();
const mockGetVoiceCall = jest.fn();
const mockBuildFollowUpContext = jest.fn();
const mockSetContactContext = jest.fn();
const mockClearContactContext = jest.fn();
const mockEnsureContactMetadata = jest.fn();

jest.mock("@/lib/database/supabase-server", () => ({
  supabaseAdmin: {
    from: mockFrom,
    schema: jest.fn(() => ({ from: mockFrom })),
  },
}));
jest.mock("../voice-call-client", () => ({
  getVoiceCall: mockGetVoiceCall,
}));
jest.mock("../voice-follow-up-context", () => ({
  buildVoiceFollowUpContext: mockBuildFollowUpContext,
}));
jest.mock("../contact-client", () => ({
  setVoiceCallContactContext: mockSetContactContext,
  clearVoiceCallContactContext: mockClearContactContext,
}));
jest.mock("../voice-agent-context", () => ({
  ensureVoiceContactMetadataEnabled: mockEnsureContactMetadata,
}));
import { handleUntrackedInboundVoiceEvent } from "../inbound-voice-context";

function readChain(data: unknown) {
  const chain: any = {
    select: jest.fn(),
    contains: jest.fn(),
    eq: jest.fn(),
    limit: jest.fn(),
    maybeSingle: jest.fn().mockResolvedValue({ data, error: null }),
  };
  chain.select.mockReturnValue(chain);
  chain.contains.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  return chain;
}

describe("inbound Voice follow-up context", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetVoiceCall.mockResolvedValue({
      id: "call-1",
      direction: "inbound",
      from: "+14155550100",
      to: "+14155550999",
      status: "initiated",
      createdAt: "2026-09-23T12:00:00.000Z",
    });
    mockBuildFollowUpContext.mockResolvedValue({
      context: "Known customer and recent interaction snapshot.",
      leadId: "lead-1",
      sources: { leadFound: true, messageCount: 3, transcriptCount: 1 },
    });
    mockSetContactContext.mockResolvedValue(undefined);
    mockClearContactContext.mockResolvedValue(undefined);
    mockEnsureContactMetadata.mockResolvedValue(undefined);
  });

  it("hydrates contact metadata when an inbound call starts", async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === "settings") return readChain({ site_id: "site-1" });
      if (table === "leads") return readChain({ id: "lead-1" });
      throw new Error(`Unexpected table ${table}`);
    });

    const result = await handleUntrackedInboundVoiceEvent({
      type: "call.initiated",
      senderId: "sender-1",
      data: { callId: "call-1" },
    }, "call-1");

    expect(result).toMatchObject({ handled: true });
    expect(mockBuildFollowUpContext).toHaveBeenCalledWith({
      siteId: "site-1",
      leadId: "lead-1",
      phone: "+14155550100",
    });
    expect(mockEnsureContactMetadata).toHaveBeenCalledWith("sender-1");
    expect(mockSetContactContext).toHaveBeenCalledWith({
      phone: "+14155550100",
      deliveryId: "call-1",
      siteId: "site-1",
      followUpContext: "Known customer and recent interaction snapshot.",
    });
  });

  it("fails instead of accepting an inbound call with no configured site", async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === "settings") return readChain(null);
      throw new Error(`Unexpected table ${table}`);
    });

    await expect(handleUntrackedInboundVoiceEvent({
      type: "call.initiated",
      senderId: "sender-missing",
      data: { callId: "call-1" },
    }, "call-1")).rejects.toThrow(
      "No site is configured for inbound Voice sender sender-missing"
    );
    expect(mockSetContactContext).not.toHaveBeenCalled();
  });

  it("stores spoken turns alongside the original Voice call without starting Customer Support", async () => {
    mockGetVoiceCall.mockResolvedValue({
      id: "call-1",
      direction: "inbound",
      from: "+14155550100",
      to: "+14155550999",
      status: "completed",
      agentId: "provider-agent-1",
      transcript: [
        { seq: 1, role: "user", text: "I need to move my appointment." },
        { seq: 2, role: "tool", text: "internal reservation payload" },
        { seq: 3, role: "assistant", text: "I can help with that." },
      ],
      createdAt: "2026-09-23T12:00:00.000Z",
      endedAt: "2026-09-23T12:02:00.000Z",
    });
    const conversationUpserts: Record<string, any>[] = [];
    const messageUpserts: Array<Record<string, any> | Array<Record<string, any>>> = [];
    const deliveryUpserts: Record<string, any>[] = [];
    mockFrom.mockImplementation((table: string) => {
      if (table === "settings") return readChain({ site_id: "site-1" });
      if (table === "leads") return readChain({ id: "lead-1" });
      if (table === "sites") return readChain({ user_id: "user-1" });
      if (table === "agents") return readChain({ id: "local-agent-1" });
      if (table === "conversations") {
        return {
          upsert: jest.fn().mockImplementation(async (payload) => {
            conversationUpserts.push(payload);
            return { error: null };
          }),
          update: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockResolvedValue({ error: null }),
            }),
          }),
        };
      }
      if (table === "messages") {
        return {
          upsert: jest.fn().mockImplementation(async (payload) => {
            messageUpserts.push(payload);
            return { error: null };
          }),
        };
      }
      if (table === "voice_call_deliveries") {
        return {
          upsert: jest.fn().mockImplementation(async (payload) => {
            deliveryUpserts.push(payload);
            return { error: null };
          }),
        };
      }
      throw new Error(`Unexpected table ${table}`);
    });

    const result = await handleUntrackedInboundVoiceEvent({
      type: "call.completed",
      senderId: "sender-1",
      data: { callId: "call-1" },
    }, "call-1");

    expect(result).toMatchObject({
      handled: true,
      delivery: {
        recipient_phone: "+14155550100",
        status: "completed",
      },
    });
    expect(conversationUpserts[0]).toMatchObject({
      channel: "voice", user_id: "user-1", agent_id: "local-agent-1",
    });
    expect(messageUpserts[0]).toMatchObject({
      conversation_id: conversationUpserts[0].id,
      role: "system",
      content: "Inbound Voice call completed.",
      custom_data: expect.objectContaining({
        source: "zavu_inbound_voice",
        voice_call_delivery_id: expect.any(String),
      }),
    });
    const speech = messageUpserts[1] as Array<Record<string, any>>;
    expect(speech.map(({ role, content }) => ({ role, content }))).toEqual([
      { role: "user", content: "I need to move my appointment." },
      { role: "assistant", content: "I can help with that." },
    ]);
    expect(speech.every((turn) => turn.conversation_id === conversationUpserts[0].id))
      .toBe(true);
    expect(speech[0].custom_data).toMatchObject({
      source: "zavu_voice_transcript",
      voice_call_delivery_id: deliveryUpserts[0].id,
    });
    expect(speech[1].agent_id).toBe("local-agent-1");
    expect(speech[0]).not.toHaveProperty("agent_id");
    expect(deliveryUpserts[0]).toMatchObject({
      zavu_call_id: "call-1",
      message_id: (messageUpserts[0] as Record<string, any>).id,
      conversation_id: conversationUpserts[0].id,
      lead_id: "lead-1",
      transcript: [
        { seq: 1, role: "user", text: "I need to move my appointment." },
        { seq: 2, role: "tool", text: "internal reservation payload" },
        { seq: 3, role: "assistant", text: "I can help with that." },
      ],
    });
    expect(mockClearContactContext).toHaveBeenCalledWith({
      phone: "+14155550100",
      deliveryId: "call-1",
    });
  });
});
