import crypto from "crypto";

const mockDecryptToken = jest.fn();
const mockExecuteCustomerSupportVoiceTool = jest.fn();
const mockMaybeSingle = jest.fn();
const mockFrom = jest.fn();

jest.mock("@/lib/utils/token-decryption", () => ({
  decryptToken: mockDecryptToken,
}));

jest.mock("@/lib/services/zavu/voice-tool-executor", () => ({
  executeCustomerSupportVoiceTool: mockExecuteCustomerSupportVoiceTool,
}));

jest.mock("@/lib/database/supabase-server", () => ({
  getSupabaseAdmin: () => ({
    from: mockFrom,
  }),
}));

import { NextRequest } from "next/server";
import { POST } from "../route";

const SITE_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function request(body: unknown, signature?: string, toolName = "reservations") {
  const rawBody = JSON.stringify(body);
  return new NextRequest(
    `https://backend.example.com/api/integrations/zavu/voice-tools?siteId=${SITE_ID}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-zavu-tool": toolName,
        "x-zavu-signature":
          signature ||
          crypto.createHmac("sha256", "whsec_test").update(rawBody).digest("hex"),
      },
      body: rawBody,
    }
  );
}

describe("Zavu Voice tools webhook", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFrom.mockImplementation((table: string) => {
      if (table !== "agents") throw new Error(`Unexpected table ${table}`);
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              order: () => ({
                limit: () => ({ maybeSingle: mockMaybeSingle }),
              }),
            }),
          }),
        }),
      };
    });
    mockMaybeSingle.mockResolvedValue({
      data: { configuration: { zavu: { tool_webhook_secret: "encrypted" } } },
      error: null,
    });
    mockDecryptToken.mockReturnValue("whsec_test");
  });

  it("executes a Customer Support tool from Zavu's arguments payload", async () => {
    mockExecuteCustomerSupportVoiceTool.mockResolvedValue({
      success: true,
      slots: [],
    });

    const response = await POST(request({
      tool: "reservations",
      arguments: {
        action: "get_available_slots",
        catalog_item_id: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
        from_date: "2026-09-24",
        to_date: "2026-09-24",
      },
      context: { contactPhone: "+14155550100", sessionId: "session-1" },
      timestamp: Date.now(),
    }));

    expect(response.status).toBe(200);
    expect(mockExecuteCustomerSupportVoiceTool).toHaveBeenCalledWith({
      toolName: "reservations",
      arguments: expect.objectContaining({
        action: "get_available_slots",
      }),
      context: {
        contactPhone: "+14155550100",
        sessionId: "session-1",
      },
      siteId: SITE_ID,
      rawPayload: expect.any(String),
    });
  });

  it("rejects an invalid signature without executing a tool", async () => {
    const response = await POST(request({
      tool: "reservations",
      arguments: { action: "list" },
    }, "0".repeat(64)));

    expect(response.status).toBe(401);
    expect(mockExecuteCustomerSupportVoiceTool).not.toHaveBeenCalled();
  });

  it("returns a client error for tools outside the Customer Support catalog", async () => {
    mockExecuteCustomerSupportVoiceTool.mockRejectedValue(
      new Error('Unknown Customer Support tool "unsafe_tool"')
    );

    const response = await POST(request({
      tool: "unsafe_tool",
      arguments: {},
    }, undefined, "unsafe_tool"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "UNKNOWN_TOOL",
    });
  });
});
