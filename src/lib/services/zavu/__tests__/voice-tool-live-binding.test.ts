const mockGetCustomerSupportVoiceToolDefinitions = jest.fn();
const mockGetCustomToolDefinition = jest.fn();
const mockTenantFrom = jest.fn();
const mockIdentifyVoiceLead = jest.fn();
const mockFindInboundVoiceLead = jest.fn();
const mockGetVoiceCall = jest.fn();
const mockLoadVoiceExecutionContext = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: {
  rpc: () => jest.requireActual('./licensed-voice-test-rpc').licensedVoiceTestRpc(),
} }));

jest.mock("../inbound-voice-lead", () => ({ findInboundVoiceLead: mockFindInboundVoiceLead }));
jest.mock("../voice-call-client", () => ({ getVoiceCall: mockGetVoiceCall }));
jest.mock('../voice-execution-context', () => ({ loadVoiceExecutionContext: mockLoadVoiceExecutionContext }));

jest.mock("../voice-tool-catalog", () => ({
  getCustomerSupportVoiceToolDefinitions: mockGetCustomerSupportVoiceToolDefinitions,
}));

jest.mock("../voice-lead-identification", () => ({
  ...jest.requireActual("../voice-lead-identification"),
  identifyVoiceLead: mockIdentifyVoiceLead,
}));

jest.mock("@/lib/agentbase/agents/toolEvaluator/executor/customToolsMap", () => ({
  getCustomToolDefinition: mockGetCustomToolDefinition,
}));

jest.mock("@/lib/database/supabase-server", () => ({
  supabaseAdmin: {
    schema: jest.fn(() => ({ from: mockTenantFrom })),
  },
}));

import { executeCustomerSupportVoiceTool } from "../voice-tool-executor";
import { VoiceToolArgumentValidationError } from "../voice-tool-parameters";

const LEAD = "11111111-1111-4111-8111-111111111111";
const OTHER_LEAD = "22222222-2222-4222-8222-222222222222";
const CONVERSATION = "33333333-3333-4333-8333-333333333333";

function singleResult(data: unknown) {
  const chain: any = {
    select: jest.fn(),
    eq: jest.fn(),
    order: jest.fn(),
    limit: jest.fn(),
    maybeSingle: jest.fn().mockResolvedValue({ data, error: null }),
  };
  chain.select.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);
  chain.order.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  return chain;
}

describe("executeCustomerSupportVoiceTool live call binding", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    mockTenantFrom.mockReset();
    mockFindInboundVoiceLead.mockReset().mockResolvedValue(undefined);
    mockGetVoiceCall.mockReset().mockResolvedValue({ id: "call-1", senderId: "sender-1", direction: "inbound",
      from: "+14155550100", status: "answered" });
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function useSourceCatalog() {
    const { getCustomerSupportVoiceToolDefinitions } = jest.requireActual("../voice-tool-catalog");
    mockGetCustomerSupportVoiceToolDefinitions.mockImplementation(getCustomerSupportVoiceToolDefinitions);
  }


  function liveCall(rows: unknown[], conversation: unknown = { id: CONVERSATION }) {
    const query: any = { select: jest.fn(), eq: jest.fn(), in: jest.fn(), is: jest.fn(),
      limit: jest.fn().mockResolvedValue({ data: rows.map(row => ({ zavu_sender_id: "sender-1", ...row as object })), error: null }) };
    for (const method of ["select", "eq", "in", "is"]) query[method].mockReturnValue(query);
    mockTenantFrom.mockImplementation(table => {
      if (table === "voice_call_deliveries") return query;
      if (table === "conversations") return singleResult(conversation);
      throw new Error(`Unexpected table ${table}`);
    });
    return query;
  }

  function requestHuman(argumentsOverride = {}) {
    return executeCustomerSupportVoiceTool({ toolName: "CONTACT_HUMAN", siteId: "site-1", rawPayload: "{}",
      context: { contactPhone: "+14155550100", sessionId: "opaque-provider-session" },
      arguments: { summary: "Identification failed", message: "Caller requests assistance", priority: "normal", ...argumentsOverride } });
  }

  it('loads private context using the verified live delivery, not model-supplied session/message IDs', async () => {
    useSourceCatalog();
    const query = liveCall([{ id: OTHER_LEAD, message_id: LEAD, conversation_id: CONVERSATION, zavu_call_id: 'call-1' }]);
    mockGetVoiceCall.mockResolvedValue({ id: 'call-1', senderId: 'sender-1', direction: 'outbound', to: '+14155550100', status: 'answered' });
    mockLoadVoiceExecutionContext.mockResolvedValue({ success: true, direction: 'outbound', objective: 'Confirm Monday appointment' });
    const result = await executeCustomerSupportVoiceTool({
      toolName: 'get_call_context', arguments: {}, siteId: 'site-1', rawPayload: '{}',
      context: { contactPhone: '+14155550100', messageId: 'untrusted-message', sessionId: 'not-a-call-id' },
    });
    expect(mockLoadVoiceExecutionContext).toHaveBeenCalledWith({
      siteId: 'site-1', conversationId: CONVERSATION, messageId: LEAD, direction: 'outbound',
    });
    expect(result).toMatchObject({ direction: 'outbound', objective: 'Confirm Monday appointment' });
    expect(query.eq).toHaveBeenCalledWith('site_id', 'site-1');
    expect(query.eq).toHaveBeenCalledWith('recipient_phone', '+14155550100');
  });

  it('rejects model-selected context and missing trusted caller before private context lookup', async () => {
    useSourceCatalog();
    await expect(executeCustomerSupportVoiceTool({
      toolName: 'get_call_context', arguments: { conversation_id: CONVERSATION }, siteId: 'site-1', rawPayload: '{}',
    })).rejects.toBeInstanceOf(VoiceToolArgumentValidationError);
    await expect(executeCustomerSupportVoiceTool({
      toolName: 'get_call_context', arguments: {}, siteId: 'site-1', rawPayload: '{}',
    })).rejects.toThrow('Trusted Voice caller context');
    expect(mockLoadVoiceExecutionContext).not.toHaveBeenCalled();
  });

  it("escalates the live call without identification and ignores stale model IDs", async () => {
    useSourceCatalog();
    // The documented call resource does not require senderId; validate it when supplied.
    mockGetVoiceCall.mockResolvedValue({ id: "call-1", direction: "inbound", from: "+14155550100", status: "answered" });
    const query = liveCall([{ id: OTHER_LEAD, conversation_id: CONVERSATION, zavu_call_id: "call-1" }]);
    mockGetCustomToolDefinition.mockReturnValue({ endpoint: { url: "/api/agents/tools/contact-human", method: "POST" } });
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, text: async () => JSON.stringify({ success: true,
      data: { intervention_id: LEAD, team_notification: { notified_emails: ["private@example.invalid"] } } }) });
    const result = await requestHuman({ lead_id: "unknown", conversation_id: "unknown", name: null, email: null });
    expect(result).toMatchObject({ success: true, status: "pending", conversation_id: CONVERSATION });
    expect(JSON.stringify(result)).not.toContain("private@example.invalid");
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body).toMatchObject({ conversation_id: CONVERSATION, voice_call_delivery_id: OTHER_LEAD, summary: "Identification failed" });
    for (const key of ["lead_id", "name", "email"]) expect(body).not.toHaveProperty(key);
    expect(query.eq).toHaveBeenCalledWith("site_id", "site-1");
    expect(query.eq).toHaveBeenCalledWith("recipient_phone", "+14155550100");
    expect(query.is).toHaveBeenCalledWith("ended_at", null);
    expect(mockIdentifyVoiceLead).not.toHaveBeenCalled();
  });

  it.each([{ rows: [] }, { rows: [{ conversation_id: CONVERSATION, zavu_call_id: "one" }, { conversation_id: CONVERSATION, zavu_call_id: "two" }] }])(
    "never escalates a historical or ambiguous call %p", async ({ rows }) => {
      useSourceCatalog();
      liveCall(rows);
      await expect(requestHuman()).rejects.toThrow(/context is not ready|Ambiguous/);
      expect(global.fetch).not.toHaveBeenCalled();
    }
  );

  it("does not escalate a conversation outside the active caller's site", async () => {
    useSourceCatalog();
    liveCall([{ id: OTHER_LEAD, conversation_id: CONVERSATION, zavu_call_id: "call-1" }], null);
    await expect(requestHuman()).rejects.toThrow("Unable to verify");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("does not report successful escalation when the backend reports failure with HTTP 200", async () => {
    useSourceCatalog();
    liveCall([{ id: OTHER_LEAD, conversation_id: CONVERSATION, zavu_call_id: "call-1" }]);
    mockGetCustomToolDefinition.mockReturnValue({ endpoint: { url: "/api/agents/tools/contact-human", method: "POST" } });
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, text: async () => JSON.stringify({ success: false, error: "Notification failed" }) });
    await expect(requestHuman()).rejects.toThrow("Notification failed");
  });

  it.each([
    { status: "completed" }, { endedAt: "2026-10-02T00:00:00Z" },
    { id: "other-call" }, { senderId: "other-sender" }, { from: "+14155550199" },
  ])("does not route assistance to a stale or mismatched provider call %p", async patch => {
    useSourceCatalog();
    liveCall([{ id: OTHER_LEAD, conversation_id: CONVERSATION, zavu_call_id: "call-1" }]);
    mockGetVoiceCall.mockResolvedValue({ id: "call-1", senderId: "sender-1", direction: "inbound",
      from: "+14155550100", status: "answered", ...patch });
    await expect(requestHuman()).rejects.toThrow("no longer active or does not match");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("fails closed if provider verification is unavailable", async () => {
    useSourceCatalog();
    liveCall([{ id: OTHER_LEAD, conversation_id: CONVERSATION, zavu_call_id: "call-1" }]);
    mockGetVoiceCall.mockRejectedValue(new Error("Provider timeout"));
    await expect(requestHuman()).rejects.toThrow("Unable to verify the live Voice call");
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
