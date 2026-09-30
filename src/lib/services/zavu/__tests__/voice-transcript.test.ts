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

import { v5 as uuidv5 } from "uuid";
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

  it("skips absent transcripts and private tool-only transcripts without HTTP failures", async () => {
    await persistVoiceTranscript({ ...params, call: { id: "call-1", direction: "inbound" } });
    await persistVoiceTranscript({ ...params, call: {
      id: "call-1",
      direction: "inbound",
      transcript: [{ seq: 0, role: "tool", text: "private" }],
    } });

    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("projects the seq 12/15 authentication failures safely alongside unchanged speech", async () => {
    const text = '{"http_status":401,"http_body":{"error":"Invalid signature"}}';
    const incidentCall = {
      ...call,
      transcript: [
        { seq: 11, role: "assistant" as const, text: "Hello", startedAt: "2026-09-23T12:00:01Z" },
        { seq: 12, role: "tool" as const, text, startedAt: "2026-09-23T12:00:02Z" },
        { seq: 13, role: "user" as const, text: "  Help\n me " },
        { seq: 14, role: "tool" as const, text: '{"http_status":200}', startedAt: "2026-09-24T12:00:00Z" },
        { seq: 15, role: "tool" as const, text, startedAt: "2026-09-23T12:00:01Z" },
        { seq: 16, role: "assistant" as const, text: "Sure", startedAt: "invalid" },
      ],
    };
    const originalCall = JSON.parse(JSON.stringify(incidentCall));
    const incidentParams = { ...params, call: incidentCall, agentId: "agent-1" };
    await persistVoiceTranscript(incidentParams);
    await persistVoiceTranscript(incidentParams);

    const [messages, options] = mockUpsert.mock.calls[0];
    expect(messages.map((message: any) => [message.role, message.content])).toEqual([
      ["assistant", "Hello"],
      ["system", "Voice tool callback authentication failed (HTTP 401)."],
      ["user", "Help me"],
      ["system", "Voice tool callback authentication failed (HTTP 401)."],
      ["assistant", "Sure"],
    ]);
    expect(messages.map((message: any) => message.id)).toEqual(
      [0, 1, 2, 4, 5].map((index) => uuidv5(`voice-turn:site-1:call-1:${index}`, uuidv5.URL))
    );
    expect(messages.map((message: any) => message.created_at)).toEqual([
      "2026-09-23T12:00:01.000Z",
      "2026-09-23T12:00:02.000Z",
      "2026-09-23T12:00:02.001Z",
      "2026-09-23T12:00:02.002Z",
      "2026-09-23T12:00:02.003Z",
    ]);
    for (const [message, seq] of [[messages[1], 12], [messages[3], 15]]) {
      expect(message.custom_data).toEqual({
        source: "zavu_voice_tool_error",
        channel_delivery: true,
        voice_mode: "agent_call",
        call_direction: "inbound",
        provider_call_id: "call-1",
        voice_call_delivery_id: "delivery-1",
        transcript_seq: seq,
        status: "failed",
        code: "VOICE_TOOL_AUTH_FAILED",
        http_status: 401,
        call_id: "call-1",
        seq,
      });
      expect(message).not.toHaveProperty("agent_id");
    }
    expect(messages[0].agent_id).toBe("agent-1");
    expect(messages[4].agent_id).toBe("agent-1");
    expect(messages[2]).not.toHaveProperty("agent_id");
    expect(JSON.stringify(messages)).not.toContain("Invalid signature");
    expect(options).toEqual({ onConflict: "id", ignoreDuplicates: true });
    expect(mockUpsert.mock.calls[1]).toEqual(mockUpsert.mock.calls[0]);
    expect(mockConversationUpdate).toHaveBeenCalledTimes(2);
    expect(incidentCall).toEqual(originalCall);
  });

  it("persists a tool-only 422 failure without copying response data, PII or secrets", async () => {
    const privateData = {
      http_status: 422,
      http_body: {
        error: "Private validation details for person@example.com",
        contacts: [{ name: "Private Person", phone: "+15555550199" }],
      },
      headers: { authorization: "Bearer private-token", "x-signature": "private-signature" },
      arguments: { email: "person@example.com", password: "private-password" },
      code: "PRIVATE_ERROR_CODE",
      call_id: "untrusted-call-id",
      seq: "private-sequence",
      source: "private-source",
    };
    await persistVoiceTranscript({
      ...params,
      call: { ...call, transcript: [{ seq: 15, role: "tool", text: JSON.stringify(privateData) }] },
    });

    const [messages] = mockUpsert.mock.calls[0];
    expect(messages).toEqual([{
      id: uuidv5("voice-turn:site-1:call-1:0", uuidv5.URL),
      conversation_id: "conversation-1",
      lead_id: "lead-1",
      role: "system",
      content: "Voice tool request failed (HTTP 422).",
      created_at: call.createdAt,
      custom_data: {
        source: "zavu_voice_tool_error",
        channel_delivery: true,
        voice_mode: "agent_call",
        call_direction: "inbound",
        provider_call_id: "call-1",
        voice_call_delivery_id: "delivery-1",
        transcript_seq: 15,
        status: "failed",
        code: "VOICE_TOOL_FAILED",
        http_status: 422,
        call_id: "call-1",
        seq: 15,
      },
    }]);
    const serialized = JSON.stringify(messages);
    for (const privateValue of [
      "http_body", "headers", "arguments", "contacts", "person@example.com",
      "Private Person", "+15555550199", "private-token", "private-signature",
      "private-password", "PRIVATE_ERROR_CODE", "untrusted-call-id", "private-sequence",
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
    expect(mockConversationUpdate).toHaveBeenCalledTimes(1);
    expect(mockConversationEq).toHaveBeenCalledWith("id", "conversation-1");
    expect(mockConversationEq.mock.results[0].value.eq).toHaveBeenCalledWith("site_id", "site-1");
  });

  it.each([400, 403, 404, 429, 500, 503, 599])("classifies HTTP %i without using provider error text", async (httpStatus) => {
    await persistVoiceTranscript({
      ...params,
      call: { ...call, transcript: [{
        seq: 12,
        role: "tool",
        text: JSON.stringify({ http_status: httpStatus, http_body: { error: "Invalid signature" } }),
      }] },
    });

    const [messages] = mockUpsert.mock.calls[0];
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "system",
      content: httpStatus === 403
        ? "Voice tool callback authentication failed (HTTP 403)."
        : `Voice tool request failed (HTTP ${httpStatus}).`,
      custom_data: {
        source: "zavu_voice_tool_error",
        code: httpStatus === 403 ? "VOICE_TOOL_AUTH_FAILED" : "VOICE_TOOL_FAILED",
        http_status: httpStatus,
        call_id: "call-1",
        seq: 12,
      },
    });
    expect(JSON.stringify(messages)).not.toContain("Invalid signature");
  });

  it.each([401, 422])("decodes a JSON-encoded JSON string for HTTP %i", async (httpStatus) => {
    const text = JSON.stringify(JSON.stringify({
      http_status: httpStatus,
      http_body: { error: "Private details", email: "person@example.com" },
    }));
    await persistVoiceTranscript({
      ...params,
      call: { ...call, transcript: [{ seq: 12, role: "tool", text }] },
    });

    const [messages] = mockUpsert.mock.calls[0];
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "system",
      custom_data: {
        http_status: httpStatus,
        code: httpStatus === 401 ? "VOICE_TOOL_AUTH_FAILED" : "VOICE_TOOL_FAILED",
      },
    });
    expect(JSON.stringify(messages)).not.toContain("Private details");
    expect(JSON.stringify(messages)).not.toContain("person@example.com");
  });

  it.each([200, 204, 301, 399])("keeps HTTP %i tool outputs hidden even when the body contains an error", async (httpStatus) => {
    const text = JSON.stringify({
      http_status: httpStatus,
      http_body: { http_status: 401, error: "Private error", email: "person@example.com" },
    });
    await persistVoiceTranscript({
      ...params,
      call: { ...call, transcript: [
        { seq: 0, role: "tool", text },
        { seq: 1, role: "tool", text: JSON.stringify(text) },
      ] },
    });

    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockConversationUpdate).not.toHaveBeenCalled();
  });

  it.each([
    { name: "plain private text", text: "person@example.com authorization: private-token" },
    { name: "malformed JSON", text: '{"http_status":401,"http_body":"person@example.com"' },
    { name: "JavaScript object syntax", text: "{http_status:401,http_body:{error:'Invalid signature'}}" },
    { name: "executable expression", text: '(() => { throw new Error("private-token"); })()' },
    { name: "array", text: '[{"http_status":401}]' },
    { name: "nested status only", text: '{"http_body":{"http_status":401}}' },
    { name: "prototype status", text: '{"__proto__":{"http_status":401}}' },
    { name: "null JSON", text: "null" },
    { name: "numeric JSON", text: "401" },
    { name: "missing status", text: '{"error":"Invalid signature"}' },
    { name: "string status", text: '{"http_status":"401"}' },
    { name: "private status", text: '{"http_status":"401 person@example.com"}' },
    { name: "fractional status", text: '{"http_status":401.5}' },
    { name: "out-of-range status", text: '{"http_status":600}' },
    { name: "nonfinite status", text: '{"http_status":1e999}' },
    { name: "triple encoding", text: JSON.stringify(JSON.stringify('{"http_status":401}')) },
    { name: "oversized JSON", text: JSON.stringify({ http_status: 401, http_body: "x".repeat(64 * 1024) }) },
    { name: "oversized whitespace", text: " ".repeat(64 * 1024) + '{"http_status":401}' },
    { name: "non-string object", text: { http_status: 401, http_body: "private-token" } },
    { name: "non-string null", text: null },
    { name: "non-string undefined", text: undefined },
  ])("ignores $name safely without interrupting speech", async ({ text }) => {
    await expect(persistVoiceTranscript({
      ...params,
      call: { ...call, transcript: [
        { seq: 0, role: "tool", text: text as string },
        { seq: 1, role: "assistant", text: "Still here" },
      ] },
    })).resolves.toBeUndefined();

    const [messages] = mockUpsert.mock.calls[0];
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: uuidv5("voice-turn:site-1:call-1:1", uuidv5.URL),
      role: "assistant",
      content: "Still here",
      created_at: "2026-09-23T12:00:00.001Z",
      custom_data: { source: "zavu_voice_transcript", transcript_seq: 1, status: "sent" },
    });
    expect(JSON.stringify(messages)).not.toContain("person@example.com");
    expect(JSON.stringify(messages)).not.toContain("private-token");
  });

  it("does not interpret spoken JSON as tool diagnostics or change speech compaction", async () => {
    const text = '{"http_status":401,"http_body":{"error":"Invalid signature"}}';
    await persistVoiceTranscript({
      ...params,
      agentId: "agent-1",
      call: { ...call, transcript: [
        { seq: 0, role: "user", text },
        { seq: 1, role: "assistant", text: " \u0000Hello\n\t there\u007F " },
        { seq: 2, role: "user", text: " \n\t " },
        { seq: 3, role: "system" as "tool", text },
      ] },
    });

    const [messages] = mockUpsert.mock.calls[0];
    expect(messages.map((message: any) => [message.role, message.content])).toEqual([
      ["user", text],
      ["assistant", "Hello there"],
    ]);
    expect(messages[0]).not.toHaveProperty("agent_id");
    expect(messages[0].custom_data.status).toBe("received");
    expect(messages[1].agent_id).toBe("agent-1");
    expect(messages[1].custom_data.status).toBe("sent");
    expect(messages.every((message: any) => message.custom_data.source === "zavu_voice_transcript")).toBe(true);
  });

  it("uses the stable index instead of copying a malformed private tool sequence", async () => {
    await persistVoiceTranscript({
      ...params,
      call: { ...call, transcript: [{
        seq: "person@example.com" as unknown as number,
        role: "tool",
        text: '{"http_status":500}',
      }] },
    });

    const [messages] = mockUpsert.mock.calls[0];
    expect(messages[0].custom_data).toMatchObject({ seq: 0, transcript_seq: 0 });
    expect(JSON.stringify(messages)).not.toContain("person@example.com");
  });

  it("retains tool-only failure IDs and timestamps on database retry and appended turns", async () => {
    const retryParams = {
      ...params,
      call: { ...call, transcript: [
        { seq: 10, role: "tool" as const, text: '{"http_status":200}' },
        { seq: 12, role: "tool" as const, text: '{"http_status":401}' },
      ] },
    };
    mockUpsert.mockResolvedValueOnce({ error: { message: "database unavailable" } });
    await expect(persistVoiceTranscript(retryParams)).rejects.toThrow("database unavailable");
    expect(mockConversationUpdate).not.toHaveBeenCalled();
    await persistVoiceTranscript(retryParams);
    expect(mockUpsert.mock.calls[1]).toEqual(mockUpsert.mock.calls[0]);

    await persistVoiceTranscript({
      ...retryParams,
      call: { ...retryParams.call, transcript: [
        ...retryParams.call.transcript,
        { seq: 15, role: "tool", text: '{"http_status":503}', startedAt: "invalid" },
      ] },
    });
    const [messages, options] = mockUpsert.mock.calls[2];
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual(mockUpsert.mock.calls[0][0][0]);
    expect(messages.map((message: any) => message.id)).toEqual(
      [1, 2].map((index) => uuidv5(`voice-turn:site-1:call-1:${index}`, uuidv5.URL))
    );
    expect(messages.map((message: any) => message.created_at)).toEqual([
      "2026-09-23T12:00:00.001Z",
      "2026-09-23T12:00:00.002Z",
    ]);
    expect(options).toEqual({ onConflict: "id", ignoreDuplicates: true });
  });

  it("propagates insert errors so Zavu can retry safely", async () => {
    mockUpsert.mockResolvedValueOnce({ error: { message: "database unavailable" } });
    await expect(persistVoiceTranscript(params)).rejects.toThrow(
      "Failed to persist Voice transcript: database unavailable"
    );
  });

  it("copies only a validated request UUID for correlation, never arbitrary response fields", async () => {
    const requestId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    await persistVoiceTranscript({
      ...params,
      call: { ...call, transcript: [
        { seq: 0, role: "tool", text: JSON.stringify({
          http_status: 401, http_body: { request_id: requestId, error: "private-token" },
        }) },
        { seq: 1, role: "tool", text: JSON.stringify({
          http_status: 422, http_body: { request_id: "private@example.com" },
        }) },
      ] },
    });
    const [messages] = mockUpsert.mock.calls[0];
    expect(messages[0].custom_data.request_id).toBe(requestId);
    expect(messages[1].custom_data).not.toHaveProperty("request_id");
    expect(JSON.stringify(messages)).not.toMatch(/private-token|private@example/);
  });
});