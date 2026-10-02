const mockGetCustomerSupportVoiceToolDefinitions = jest.fn();
const mockGetCustomToolDefinition = jest.fn();
const mockTenantFrom = jest.fn();
const mockIdentifyVoiceLead = jest.fn();
const mockFindInboundVoiceLead = jest.fn();
const mockGetVoiceCall = jest.fn();
const mockLoadVoiceExecutionContext = jest.fn();

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

describe("executeCustomerSupportVoiceTool", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFindInboundVoiceLead.mockReset().mockResolvedValue(undefined);
    mockGetVoiceCall.mockReset().mockResolvedValue({ id: "call-1", senderId: "sender-1", direction: "inbound",
      from: "+14155550100", status: "answered" });
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("scopes native tool calls to the current site and caller", async () => {
    mockFindInboundVoiceLead.mockResolvedValue("lead-1");
    const execute = jest.fn().mockResolvedValue({ success: true });
    mockGetCustomerSupportVoiceToolDefinitions.mockReturnValue([{
      name: "reservations",
      description: "Manage reservations",
      parameters: {
        type: "object",
        properties: {
          site_id: { type: "string" },
          lead_id: { type: "string" },
          phone: { type: "string" },
          conversation_id: { type: "string" },
        },
      },
      execute,
    }]);
    liveCall([{ id: OTHER_LEAD, conversation_id: CONVERSATION, zavu_call_id: 'call-1' }]);

    await executeCustomerSupportVoiceTool({
      toolName: "reservations",
      arguments: { action: "list", site_id: "untrusted-site" },
      siteId: "site-1",
      context: { contactPhone: "+14155550100" },
      rawPayload: '{"tool":"reservations","timestamp":1}',
    });

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      action: "list",
      site_id: "site-1",
      lead_id: "lead-1",
      phone: "+14155550100",
      conversation_id: CONVERSATION,
      command_id: expect.any(String),
    }));
  });

  it("executes API-backed Customer Support tools directly", async () => {
    mockGetCustomerSupportVoiceToolDefinitions.mockReturnValue([{
      name: "GET_TASKS",
      description: "Get tasks",
      parameters: {
        type: "object",
        properties: { lead_id: { type: "string" } },
      },
    }]);
    mockGetCustomToolDefinition.mockReturnValue({
      endpoint: {
        url: "/api/agents/tools/tasks/get",
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
    });
    mockTenantFrom.mockImplementation((table: string) => {
      if (table === "leads") return singleResult({ id: LEAD });
      throw new Error(`Unexpected table ${table}`);
    });
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      text: jest.fn().mockResolvedValue('{"success":true,"tasks":[]}'),
    });

    await expect(executeCustomerSupportVoiceTool({
      toolName: "GET_TASKS",
      arguments: { lead_id: LEAD },
      siteId: "site-1",
      rawPayload: '{"tool":"GET_TASKS","timestamp":1}',
    })).resolves.toEqual({ success: true, tasks: [] });

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/agents/tools/tasks/get"),
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining(`"lead_id":"${LEAD}"`),
      })
    );
  });

  it("rejects tools outside the Customer Support catalog", async () => {
    mockGetCustomerSupportVoiceToolDefinitions.mockReturnValue([]);

    await expect(executeCustomerSupportVoiceTool({
      toolName: "unsafe_tool",
      arguments: {},
      siteId: "site-1",
      rawPayload: "{}",
    })).rejects.toThrow('Unknown Customer Support tool "unsafe_tool"');
  });

  function useSourceCatalog() {
    const { getCustomerSupportVoiceToolDefinitions } = jest.requireActual("../voice-tool-catalog");
    mockGetCustomerSupportVoiceToolDefinitions.mockImplementation(getCustomerSupportVoiceToolDefinitions);
  }

  it.each([
    [{ action: "list", resource: "service" }, "resource"],
    [{ action: "search", resource: "item" }, "action"],
    [{ action: "list", resource: "invented" }, "resource"],
    [{ action: "list", limit: "10" }, "limit"],
    [{ resource: "item" }, "action"],
  ])("rejects invalid catalog arguments before native execution/network without resource coercion", async (args, field) => {
    useSourceCatalog();
    const execution = executeCustomerSupportVoiceTool({
      toolName: "catalog_commerce", arguments: args, siteId: "site-1", rawPayload: "{}",
    });
    await expect(execution).rejects.toBeInstanceOf(VoiceToolArgumentValidationError);
    await expect(execution).rejects.toMatchObject({ code: "VOICE_TOOL_INVALID_ARGUMENTS", fields: [field] });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockGetCustomToolDefinition).not.toHaveBeenCalled();
    expect(mockTenantFrom).not.toHaveBeenCalled();
  });

  it("passes a valid service list to the real native executor scoped to the authenticated site", async () => {
    useSourceCatalog();
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true, text: jest.fn().mockResolvedValue('{"success":true,"items":[]}'),
    });
    await executeCustomerSupportVoiceTool({
      toolName: "catalog_commerce",
      arguments: { action: "list", resource: "item", kind: "service", site_id: "foreign-site" },
      siteId: "site-1", rawPayload: "{}",
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(JSON.parse(options.body)).toMatchObject({
      action: "list", resource: "item", kind: "service", site_id: "site-1",
    });
  });

  it("rejects nested array constraints before a native tool network call", async () => {
    useSourceCatalog();
    await expect(executeCustomerSupportVoiceTool({
      toolName: "promotions", siteId: "site-1", rawPayload: "{}",
      arguments: { action: "list", channels: ["unknown"], required_items: [{ min_quantity: "two" }] },
    })).rejects.toMatchObject({ fields: ["channels[]", "required_items[].min_quantity"] });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("preserves documented null=unlimited on native catalog updates", async () => {
    useSourceCatalog();
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, text: jest.fn().mockResolvedValue('{"success":true}') });
    await executeCustomerSupportVoiceTool({
      toolName: "catalog_commerce", siteId: "site-1", rawPayload: "{}",
      arguments: { action: "update", resource: "modifier_group", id: "group-1", max_select: null },
    });
    const [, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(JSON.parse(options.body)).toMatchObject({ resource: "modifier_group", max_select: null, site_id: "site-1" });
  });

  it("rejects source constraint violations before an API-backed tool fetch", async () => {
    useSourceCatalog();
    mockTenantFrom.mockReturnValue(singleResult({ id: LEAD }));
    await expect(executeCustomerSupportVoiceTool({
      toolName: "GET_TASKS", siteId: "site-1", rawPayload: "{}",
      arguments: { lead_id: LEAD, status: "invented", limit: 101 },
    })).rejects.toMatchObject({ fields: ["status", "limit"] });
    expect(mockGetCustomToolDefinition).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("validates after trusted lead/site scoping and before internal command_id injection", async () => {
    useSourceCatalog();
    mockFindInboundVoiceLead.mockResolvedValue("lead-1");
    mockTenantFrom.mockReturnValue(singleResult({ id: "lead-1" }));
    mockGetCustomToolDefinition.mockReturnValue({ endpoint: { url: "/api/agents/tools/leads/qualify", method: "POST" } });
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true, text: jest.fn().mockResolvedValue('{"success":true}'),
    });
    await executeCustomerSupportVoiceTool({
      toolName: "QUALIFY_LEAD", siteId: "site-1", rawPayload: "{}",
      arguments: { site_id: "foreign-site", status: "qualified" },
      context: { contactPhone: "+13015550100" },
    });
    const [, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(JSON.parse(options.body)).toMatchObject({
      site_id: "site-1", lead_id: "lead-1", phone: "+13015550100", status: "qualified", command_id: expect.any(String),
    });
  });

  it("uses the native IDENTIFY_LEAD adapter before visitor/conversation scoping or HTTP fallback", async () => {
    const legacyExecute = jest.fn();
    mockGetCustomerSupportVoiceToolDefinitions.mockReturnValue([{
      name: "IDENTIFY_LEAD",
      // Even a stale shared definition must not trigger conversation lookups.
      parameters: { properties: { conversation: {}, phone: {} } },
      execute: legacyExecute,
    }]);
    mockIdentifyVoiceLead.mockResolvedValue({ success: true, lead_id: "new-lead", is_new_lead: true });
    const args = {
      name: "Ada", email: "ada@example.com", phone: "+14155550199", consent: true,
      site_id: "untrusted-site", user_id: "untrusted-user", conversation: "invented",
    };
    await expect(executeCustomerSupportVoiceTool({
      toolName: "IDENTIFY_LEAD", arguments: args, siteId: "site-1",
      context: { contactPhone: "+13015550100", siteId: "other-site" }, rawPayload: "{}",
    })).resolves.toEqual({ success: true, lead_id: "new-lead", is_new_lead: true });
    expect(mockIdentifyVoiceLead).toHaveBeenCalledWith({
      siteId: "site-1", contactPhone: "+13015550100", arguments: args,
    });
    // The helper receives the original supplied phone to reject mismatches.
    expect(mockTenantFrom).not.toHaveBeenCalled();
    expect(mockGetCustomToolDefinition).not.toHaveBeenCalled();
    expect(legacyExecute).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("propagates native consent failures without calling the browser identify endpoint", async () => {
    mockGetCustomerSupportVoiceToolDefinitions.mockReturnValue([{ name: "IDENTIFY_LEAD" }]);
    mockIdentifyVoiceLead.mockRejectedValue(new Error("Explicit caller consent is required"));
    await expect(executeCustomerSupportVoiceTool({
      toolName: "IDENTIFY_LEAD", arguments: {}, siteId: "site-1", rawPayload: "{}",
    })).rejects.toThrow("Explicit caller consent");
    expect(mockGetCustomToolDefinition).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("does not key native lead replay on a changed body, timestamp or session", async () => {
    mockGetCustomerSupportVoiceToolDefinitions.mockReturnValue([{ name: "IDENTIFY_LEAD" }]);
    mockIdentifyVoiceLead.mockResolvedValue({ success: true, lead_id: "new-lead", is_new_lead: false });
    const args = { name: "Ada", email: "ada@example.com", consent: true };
    for (const timestamp of [1, 2]) {
      await executeCustomerSupportVoiceTool({
        toolName: "IDENTIFY_LEAD", arguments: args, siteId: "site-1",
        context: { contactPhone: "+13015550100", sessionId: `session-${timestamp}` },
        rawPayload: JSON.stringify({ timestamp }),
      });
    }
    expect(mockIdentifyVoiceLead.mock.calls[0]).toEqual(mockIdentifyVoiceLead.mock.calls[1]);
  });

  function schedulingDefinition(execute: jest.Mock) {
    return { name: "scheduling", parameters: { properties: { lead_id: {}, context_id: {} } }, execute };
  }

  it("uses the newly identified caller for BOTH scheduling lead aliases, without changing phone digits", async () => {
    const execute = jest.fn().mockResolvedValue({ success: true });
    mockGetCustomerSupportVoiceToolDefinitions.mockReturnValue([schedulingDefinition(execute)]);
    mockFindInboundVoiceLead.mockResolvedValue("new-lead");
    await executeCustomerSupportVoiceTool({
      toolName: "scheduling", siteId: "site-1",
      arguments: { action: "schedule", context_id: "untrusted-lead", lead_id: "another-lead" },
      context: { contactPhone: "+13015550100" }, rawPayload: "{}",
    });
    expect(mockFindInboundVoiceLead).toHaveBeenCalledWith("site-1", "+13015550100");
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ lead_id: "new-lead", context_id: "new-lead" }));
  });

  it("validates a scheduling context_id fallback against the authenticated site", async () => {
    const execute = jest.fn();
    mockGetCustomerSupportVoiceToolDefinitions.mockReturnValue([schedulingDefinition(execute)]);
    const leadQuery = singleResult(null);
    mockTenantFrom.mockReturnValue(leadQuery);
    await expect(executeCustomerSupportVoiceTool({
      toolName: "scheduling", siteId: "site-1",
      arguments: { action: "list", context_id: OTHER_LEAD }, rawPayload: "{}",
    })).rejects.toThrow("does not belong to this site");
    expect(leadQuery.eq).toHaveBeenCalledWith("id", OTHER_LEAD);
    expect(leadQuery.eq).toHaveBeenCalledWith("site_id", "site-1");
    expect(execute).not.toHaveBeenCalled();
  });

  it("accepts the identified lead_id for subsequent scheduling even without caller context", async () => {
    const execute = jest.fn().mockResolvedValue({ success: true });
    mockGetCustomerSupportVoiceToolDefinitions.mockReturnValue([schedulingDefinition(execute)]);
    mockTenantFrom.mockReturnValue(singleResult({ id: LEAD }));
    await executeCustomerSupportVoiceTool({
      toolName: "scheduling", siteId: "site-1",
      arguments: { action: "schedule", lead_id: LEAD }, rawPayload: "{}",
    });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ lead_id: LEAD, context_id: LEAD }));
  });

  it("rejects disagreeing scheduling lead aliases instead of prioritizing an arbitrary context_id", async () => {
    const execute = jest.fn();
    mockGetCustomerSupportVoiceToolDefinitions.mockReturnValue([schedulingDefinition(execute)]);
    mockTenantFrom.mockReturnValueOnce(singleResult({ id: LEAD }))
      .mockReturnValueOnce(singleResult({ id: OTHER_LEAD }));
    await expect(executeCustomerSupportVoiceTool({
      toolName: "scheduling", siteId: "site-1",
      arguments: { action: "schedule", lead_id: LEAD, context_id: OTHER_LEAD }, rawPayload: "{}",
    })).rejects.toThrow("must identify the same lead");
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails rather than selecting an arbitrary caller lead on ambiguous lookup", async () => {
    const execute = jest.fn();
    mockGetCustomerSupportVoiceToolDefinitions.mockReturnValue([schedulingDefinition(execute)]);
    mockFindInboundVoiceLead.mockRejectedValue(new Error("Ambiguous inbound Voice lead; human review required"));
    await expect(executeCustomerSupportVoiceTool({
      toolName: "scheduling", siteId: "site-1", arguments: { action: "list" },
      context: { contactPhone: "+13015550100" }, rawPayload: "{}",
    })).rejects.toThrow("Ambiguous inbound Voice lead");
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([null, "", "  "])("checks availability with absent optional lead context %p", async absent => {
    const execute = jest.fn().mockResolvedValue({ slots: [] });
    mockGetCustomerSupportVoiceToolDefinitions.mockReturnValue([schedulingDefinition(execute)]);
    await executeCustomerSupportVoiceTool({ toolName: "scheduling", siteId: "site-1", rawPayload: "{}",
      arguments: { action: "check_availability", context_id: absent, lead_id: absent } });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ action: "check_availability" }));
    expect(execute.mock.calls[0][0]).not.toHaveProperty("context_id");
    expect(mockTenantFrom).not.toHaveBeenCalled();
    expect(mockFindInboundVoiceLead).not.toHaveBeenCalled();
  });

  it.each(["list", "schedule"])("never executes unscoped scheduling %s before identification", async action => {
    const execute = jest.fn();
    mockGetCustomerSupportVoiceToolDefinitions.mockReturnValue([schedulingDefinition(execute)]);
    await expect(executeCustomerSupportVoiceTool({ toolName: "scheduling", siteId: "site-1", rawPayload: "{}",
      arguments: { action, context_id: null, lead_id: "" } })).rejects.toMatchObject({
      code: "VOICE_TOOL_INVALID_ARGUMENTS", fields: ["context_id"],
    });
    expect(execute).not.toHaveBeenCalled();
    expect(mockTenantFrom).not.toHaveBeenCalled();
  });

  it.each(["unknown", "not-a-uuid", 123, {}])("rejects invented UUID %p before Postgres", async id => {
    const execute = jest.fn();
    mockGetCustomerSupportVoiceToolDefinitions.mockReturnValue([schedulingDefinition(execute)]);
    await expect(executeCustomerSupportVoiceTool({ toolName: "scheduling", siteId: "site-1", rawPayload: "{}",
      arguments: { action: "list", context_id: id } })).rejects.toMatchObject({
      code: "VOICE_TOOL_INVALID_ARGUMENTS", fields: ["context_id"],
    });
    expect(execute).not.toHaveBeenCalled();
    expect(mockTenantFrom).not.toHaveBeenCalled();
  });

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
