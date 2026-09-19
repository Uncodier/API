import crypto from "crypto";

const mockDecryptToken = jest.fn();
const mockManageLeadCreation = jest.fn();
const mockMaybeSingle = jest.fn();

jest.mock("@/lib/utils/token-decryption", () => ({
  decryptToken: mockDecryptToken,
}));

jest.mock("@/lib/services/leads/lead-service", () => ({
  manageLeadCreation: mockManageLeadCreation,
}));

jest.mock("@/lib/database/supabase-server", () => ({
  getSupabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            order: () => ({
              limit: () => ({ maybeSingle: mockMaybeSingle }),
            }),
          }),
        }),
      }),
    }),
  }),
}));

import { NextRequest } from "next/server";
import { POST } from "../route";

const SITE_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function request(body: unknown, signature?: string) {
  const rawBody = JSON.stringify(body);
  return new NextRequest(
    `https://backend.example.com/api/integrations/zavu/voice-tools?siteId=${SITE_ID}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-zavu-tool": "capture_lead",
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
    mockMaybeSingle.mockResolvedValue({
      data: { configuration: { zavu: { tool_webhook_secret: "encrypted" } } },
      error: null,
    });
    mockDecryptToken.mockReturnValue("whsec_test");
  });

  it("creates a real lead from Zavu's arguments payload", async () => {
    mockManageLeadCreation.mockResolvedValue({
      leadId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
      isNewLead: true,
      taskId: null,
    });

    const response = await POST(request({
      tool: "capture_lead",
      arguments: {
        name: "Ada Lovelace",
        phone: "+14155550100",
        email: "ada@example.com",
      },
      timestamp: Date.now(),
    }));

    expect(response.status).toBe(200);
    expect(mockManageLeadCreation).toHaveBeenCalledWith({
      name: "Ada Lovelace",
      phone: "+14155550100",
      email: "ada@example.com",
      siteId: SITE_ID,
      origin: "voice",
      createTask: true,
    });
  });

  it("rejects an invalid signature without writing a lead", async () => {
    const response = await POST(request({
      tool: "capture_lead",
      arguments: { name: "Ada Lovelace", phone: "+14155550100" },
    }, "0".repeat(64)));

    expect(response.status).toBe(401);
    expect(mockManageLeadCreation).not.toHaveBeenCalled();
  });
});
