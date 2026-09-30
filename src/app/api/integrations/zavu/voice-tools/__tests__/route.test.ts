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

function request(body: unknown, signature?: string, toolName: string | null = "reservations") {
  const rawBody = JSON.stringify(body);
  return new NextRequest(
    `https://backend.example.com/api/integrations/zavu/voice-tools?siteId=${SITE_ID}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(toolName !== null ? { "x-zavu-tool": toolName } : {}),
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
    mockExecuteCustomerSupportVoiceTool.mockReset();
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

  it("uses a signed body tool name when Zavu omits its header", async () => {
    mockExecuteCustomerSupportVoiceTool.mockResolvedValue({ success: true });
    const response = await POST(request({
      tool: "reservations",
      arguments: { action: "list" },
    }, undefined, null));

    expect(response.status).toBe(200);
    expect(mockExecuteCustomerSupportVoiceTool).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "reservations", siteId: SITE_ID })
    );
  });

  it("rejects an unsigned body tool name without executing it", async () => {
    const response = await POST(request({
      tool: "reservations",
      arguments: {},
    }, "0".repeat(64), null));

    expect(response.status).toBe(401);
    expect(mockExecuteCustomerSupportVoiceTool).not.toHaveBeenCalled();
  });

  it("rejects mismatched header and signed body tool names", async () => {
    const response = await POST(request({
      tool: "CREATE_TASK",
      arguments: {},
    }));

    expect(response.status).toBe(400);
    expect(mockExecuteCustomerSupportVoiceTool).not.toHaveBeenCalled();
  });

  it("rejects requests without a tool name after authenticating", async () => {
    const response = await POST(request({ arguments: {} }, undefined, null));

    expect(response.status).toBe(400);
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

  it("logs a missing signature safely and never executes an unsigned voice callback", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const req = request({
        tool: "IDENTIFY_LEAD",
        arguments: { email: "private@example.com", phone: "+14155550100" },
      });
      req.headers.delete("x-zavu-signature");
      req.headers.delete("x-zavu-tool");
      const response = await POST(req);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.code).toBe("VOICE_TOOL_AUTH_FAILED");
      expect(body.request_id).toBe(response.headers.get("x-request-id"));
      expect(warn).toHaveBeenCalledWith("[Zavu Voice Tool]", expect.objectContaining({
        event: "authentication_failed",
        reason: "missing_signature",
        signature_format: "missing",
        has_tool_header: false,
        has_timestamp_header: false,
        has_authorization_header: false,
        secret_configured: true,
        secret_decryptable: true,
      }));
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private@example|14155550100|whsec_test|encrypted/);
      expect(mockExecuteCustomerSupportVoiceTool).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("distinguishes an unreadable secret from a wrong digest in server logs only", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      mockDecryptToken.mockReturnValueOnce(null);
      const response = await POST(request({ tool: "reservations", arguments: {} }));
      expect(response.status).toBe(401);
      expect(warn).toHaveBeenCalledWith("[Zavu Voice Tool]", expect.objectContaining({
        reason: "missing_secret", secret_configured: true, secret_decryptable: false,
      }));
      expect(await response.json()).not.toHaveProperty("reason");
      expect(mockExecuteCustomerSupportVoiceTool).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("does not accept a different site's signing secret", async () => {
    const payload = { tool: "reservations", arguments: {} };
    const otherSignature = crypto.createHmac("sha256", "other-site-secret")
      .update(JSON.stringify(payload)).digest("hex");
    const response = await POST(request(payload, otherSignature));
    expect(response.status).toBe(401);
    expect(mockExecuteCustomerSupportVoiceTool).not.toHaveBeenCalled();
  });

  it("correlates execution failures without logging raw tool errors or arguments", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      mockExecuteCustomerSupportVoiceTool.mockRejectedValueOnce(new Error("private caller data"));
      const response = await POST(request({ tool: "reservations", arguments: {} }));
      expect(response.status).toBe(422);
      expect(warn).toHaveBeenCalledWith("[Zavu Voice Tool]", expect.objectContaining({
        event: "execution_failed", status: 422, tool: "reservations",
        request_id: response.headers.get("x-request-id"),
      }));
      expect(JSON.stringify(warn.mock.calls)).not.toContain("private caller data");
    } finally {
      warn.mockRestore();
    }
  });
});
