const mockGetCustomerSupportToolDefinitions = jest.fn();
const mockGetCustomToolDefinition = jest.fn();
const mockTenantFrom = jest.fn();

jest.mock("@/lib/services/customer-support-tool-catalog", () => ({
  getCustomerSupportToolDefinitions: mockGetCustomerSupportToolDefinitions,
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
    mockGetCustomerSupportToolDefinitions.mockReturnValue([{
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
    mockGetCustomerSupportToolDefinitions.mockReturnValue([{
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
    mockGetCustomerSupportToolDefinitions.mockReturnValue([]);

    await expect(executeCustomerSupportVoiceTool({
      toolName: "unsafe_tool",
      arguments: {},
      siteId: "site-1",
      rawPayload: "{}",
    })).rejects.toThrow('Unknown Customer Support tool "unsafe_tool"');
  });
});
