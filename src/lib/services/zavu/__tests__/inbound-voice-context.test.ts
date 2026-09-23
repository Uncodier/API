const mockFrom = jest.fn();
const mockGetVoiceCall = jest.fn();
const mockBuildFollowUpContext = jest.fn();
const mockSetContactContext = jest.fn();
const mockClearContactContext = jest.fn();
const mockEnsureContactMetadata = jest.fn();

jest.mock("@/lib/database/supabase-server", () => ({
  supabaseAdmin: { from: mockFrom },
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

  it("persists a completed inbound call for future follow-up", async () => {
    mockGetVoiceCall.mockResolvedValue({
      id: "call-1",
      direction: "inbound",
      from: "+14155550100",
      to: "+14155550999",
      status: "completed",
      transcript: [
        { seq: 1, role: "user", text: "I need to move my appointment." },
      ],
      createdAt: "2026-09-23T12:00:00.000Z",
      endedAt: "2026-09-23T12:02:00.000Z",
    });
    const upserts: Record<string, unknown>[] = [];
    mockFrom.mockImplementation((table: string) => {
      if (table === "settings") return readChain({ site_id: "site-1" });
      if (table === "leads") return readChain({ id: "lead-1" });
      if (["conversations", "messages", "voice_call_deliveries"].includes(table)) {
        return {
          upsert: jest.fn().mockImplementation(async (payload) => {
            upserts.push({ table, payload });
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
    expect(upserts.map((entry) => entry.table)).toEqual([
      "conversations",
      "messages",
      "voice_call_deliveries",
    ]);
    expect(upserts[2].payload).toMatchObject({
      zavu_call_id: "call-1",
      transcript: [
        { seq: 1, role: "user", text: "I need to move my appointment." },
      ],
    });
    expect(mockClearContactContext).toHaveBeenCalledWith({
      phone: "+14155550100",
      deliveryId: "call-1",
    });
  });
});
