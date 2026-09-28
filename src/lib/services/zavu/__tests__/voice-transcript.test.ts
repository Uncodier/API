const mockUpsert = jest.fn();
const mockConversationEq = jest.fn();
const mockConversationUpdate = jest.fn();
const mockSchemaFrom = jest.fn();

jest.mock("@/lib/database/supabase-server", () => ({
  supabaseAdmin: {
    schema: jest.fn(() => ({
      from: mockSchemaFrom,
    })),
  },
}));

import { persistVoiceTranscript } from "../voice-transcript";

const call = {
  id: "call-1",
  direction: "inbound" as const,
  createdAt: "2026-09-23T12:00:00.000Z",
  transcript: [
    { seq: 0, role: "assistant" as const, text: "Hello", startedAt: "2026-09-23T12:00:01Z" },
    { seq: 1, role: "tool" as const, text: '{"token":"private"}' },
    { seq: 2, role: "user" as const, text: "  Help\n me ", startedAt: "2026-09-23T12:00:03Z" },
    { seq: 3, role: "assistant" as const, text: "Sure", startedAt: "invalid" },
  ],
};

const params = {
  call,
  siteId: "site-1",
  conversationId: "conversation-1",
  deliveryId: "delivery-1",
  leadId: "lead-1",
};

describe("persistVoiceTranscript", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpsert.mockResolvedValue({ error: null });
    mockConversationEq.mockImplementation(() => ({
      eq: jest.fn().mockResolvedValue({ error: null }),
    }));
    mockConversationUpdate.mockReturnValue({ eq: mockConversationEq });
    mockSchemaFrom.mockImplementation((table: string) => {
      if (table === "messages") return { upsert: mockUpsert };
      if (table === "conversations") return { update: mockConversationUpdate };
      throw new Error(`Unexpected table ${table}`);
    });
  });

  it("saves only spoken turns in sequence with stable IDs and preserves the original call", async () => {
    await persistVoiceTranscript(params);
    await persistVoiceTranscript(params);

    expect(mockUpsert).toHaveBeenCalledTimes(2);
    const [messages, options] = mockUpsert.mock.calls[0];
    expect(messages.map((message: any) => [message.role, message.content])).toEqual([
      ["assistant", "Hello"],
      ["user", "Help me"],
      ["assistant", "Sure"],
    ]);
    expect(messages[0].created_at).toBe("2026-09-23T12:00:01.000Z");
    expect(messages[1].created_at).toBe("2026-09-23T12:00:03.000Z");
    expect(messages[2].created_at).toBe("2026-09-23T12:00:03.001Z");
    expect(messages[0].custom_data).toMatchObject({
      source: "zavu_voice_transcript",
      call_direction: "inbound",
      voice_call_delivery_id: "delivery-1",
    });
    expect(options).toEqual({ onConflict: "id", ignoreDuplicates: true });
    expect(mockUpsert.mock.calls[1][0].map((message: any) => message.id))
      .toEqual(messages.map((message: any) => message.id));
    expect(mockConversationUpdate).toHaveBeenCalledTimes(2);
    expect(call.transcript[1].text).toBe('{"token":"private"}');
  });

  it("projects outbound speech while keeping the original campaign message separate", async () => {
    await persistVoiceTranscript({ ...params, call: { ...call, direction: "outbound" } });

    const [messages] = mockUpsert.mock.calls[0];
    expect(messages).toHaveLength(3);
    expect(messages[0].custom_data).toMatchObject({
      source: "zavu_voice_transcript",
      call_direction: "outbound",
    });
  });

  it("skips absent or tool-only transcripts", async () => {
    await persistVoiceTranscript({ ...params, call: { id: "call-1", direction: "inbound" } });
    await persistVoiceTranscript({ ...params, call: {
      id: "call-1",
      direction: "inbound",
      transcript: [{ seq: 0, role: "tool", text: "private" }],
    } });

    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("propagates insert errors so Zavu can retry safely", async () => {
    mockUpsert.mockResolvedValueOnce({ error: { message: "database unavailable" } });
    await expect(persistVoiceTranscript(params)).rejects.toThrow(
      "Failed to persist Voice transcript: database unavailable"
    );
  });
});