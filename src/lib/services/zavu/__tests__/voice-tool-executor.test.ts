const mockGetCustomerSupportVoiceToolDefinitions = jest.fn();
const mockGetCustomToolDefinition = jest.fn();
const mockTenantFrom = jest.fn();
const mockIdentifyVoiceLead = jest.fn();

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
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("scopes native tool calls to the current site and caller", async () => {
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
    mockTenantFrom.mockImplementation((table: string) => {
      if (table === "leads") return singleResult({ id: "lead-1" });
      if (table === "conversations") {
        return singleResult({ id: "conversation-1" });
      }
      throw new Error(`Unexpected table ${table}`);
    });

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
      conversation_id: "conversation-1",
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
      if (table === "leads") return singleResult({ id: "lead-1" });
      throw new Error(`Unexpected table ${table}`);
    });
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      text: jest.fn().mockResolvedValue('{"success":true,"tasks":[]}'),
    });

    await expect(executeCustomerSupportVoiceTool({
      toolName: "GET_TASKS",
      arguments: { lead_id: "lead-1" },
      siteId: "site-1",
      rawPayload: '{"tool":"GET_TASKS","timestamp":1}',
    })).resolves.toEqual({ success: true, tasks: [] });

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/agents/tools/tasks/get"),
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"lead_id":"lead-1"'),
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
    const leadQuery = singleResult({ id: "new-lead" });
    mockTenantFrom.mockReturnValue(leadQuery);
    await executeCustomerSupportVoiceTool({
      toolName: "scheduling", siteId: "site-1",
      arguments: { action: "schedule", context_id: "untrusted-lead", lead_id: "another-lead" },
      context: { contactPhone: "+13015550100" }, rawPayload: "{}",
    });
    expect(leadQuery.eq).toHaveBeenCalledWith("site_id", "site-1");
    expect(leadQuery.eq).toHaveBeenCalledWith("phone", "+13015550100");
    expect(leadQuery.limit).toHaveBeenCalledWith(2);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ lead_id: "new-lead", context_id: "new-lead" }));
  });

  it("validates a scheduling context_id fallback against the authenticated site", async () => {
    const execute = jest.fn();
    mockGetCustomerSupportVoiceToolDefinitions.mockReturnValue([schedulingDefinition(execute)]);
    const leadQuery = singleResult(null);
    mockTenantFrom.mockReturnValue(leadQuery);
    await expect(executeCustomerSupportVoiceTool({
      toolName: "scheduling", siteId: "site-1",
      arguments: { action: "list", context_id: "foreign-lead" }, rawPayload: "{}",
    })).rejects.toThrow("does not belong to this site");
    expect(leadQuery.eq).toHaveBeenCalledWith("id", "foreign-lead");
    expect(leadQuery.eq).toHaveBeenCalledWith("site_id", "site-1");
    expect(execute).not.toHaveBeenCalled();
  });

  it("accepts the identified lead_id for subsequent scheduling even without caller context", async () => {
    const execute = jest.fn().mockResolvedValue({ success: true });
    mockGetCustomerSupportVoiceToolDefinitions.mockReturnValue([schedulingDefinition(execute)]);
    mockTenantFrom.mockReturnValue(singleResult({ id: "new-lead" }));
    await executeCustomerSupportVoiceTool({
      toolName: "scheduling", siteId: "site-1",
      arguments: { action: "schedule", lead_id: "new-lead" }, rawPayload: "{}",
    });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ lead_id: "new-lead", context_id: "new-lead" }));
  });

  it("rejects disagreeing scheduling lead aliases instead of prioritizing an arbitrary context_id", async () => {
    const execute = jest.fn();
    mockGetCustomerSupportVoiceToolDefinitions.mockReturnValue([schedulingDefinition(execute)]);
    mockTenantFrom.mockReturnValueOnce(singleResult({ id: "lead-1" }))
      .mockReturnValueOnce(singleResult({ id: "lead-2" }));
    await expect(executeCustomerSupportVoiceTool({
      toolName: "scheduling", siteId: "site-1",
      arguments: { action: "schedule", lead_id: "lead-1", context_id: "lead-2" }, rawPayload: "{}",
    })).rejects.toThrow("must identify the same lead");
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails rather than selecting an arbitrary caller lead on ambiguous lookup", async () => {
    const execute = jest.fn();
    mockGetCustomerSupportVoiceToolDefinitions.mockReturnValue([schedulingDefinition(execute)]);
    const query = singleResult(null);
    query.maybeSingle.mockResolvedValue({ error: { message: "multiple private records" } });
    mockTenantFrom.mockReturnValue(query);
    await expect(executeCustomerSupportVoiceTool({
      toolName: "scheduling", siteId: "site-1", arguments: { action: "list" },
      context: { contactPhone: "+13015550100" }, rawPayload: "{}",
    })).rejects.toThrow(/^Unable to resolve an unambiguous Voice tool lead$/);
    expect(execute).not.toHaveBeenCalled();
  });
});
