import { getLeadById } from "@/lib/database/lead-db";
import { supabaseAdmin } from "@/lib/database/supabase-server";
import { placeTrackedVoiceCall } from "@/lib/services/zavu/voice-call-service";
import { placeVoiceCallTool } from "../assistantProtocol";

jest.mock("@/lib/database/lead-db", () => ({
  getLeadById: jest.fn(),
}));
jest.mock("@/lib/database/supabase-server", () => ({
  supabaseAdmin: { from: jest.fn() },
}));
jest.mock("@/lib/services/zavu/voice-call-service", () => ({
  placeTrackedVoiceCall: jest.fn(),
}));

const SITE_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const USER_ID = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const LEAD_ID = "cccccccc-dddd-4eee-8fff-000000000000";

describe("placeVoiceCallTool", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getLeadById as jest.Mock).mockResolvedValue({
      id: LEAD_ID,
      site_id: SITE_ID,
      phone: "+52 1555 123 4567",
    });
    (supabaseAdmin.from as jest.Mock).mockImplementation(() => ({
      upsert: jest.fn().mockResolvedValue({ error: null }),
      update: jest.fn().mockReturnValue({
        eq: jest.fn().mockResolvedValue({ error: null }),
      }),
    }));
    (placeTrackedVoiceCall as jest.Mock).mockResolvedValue({
      deliveryId: "delivery-1",
      duplicate: false,
      call: { id: "call-1", status: "queued" },
    });
  });

  it("creates records and places a site-scoped call with private context", async () => {
    const result = await placeVoiceCallTool(SITE_ID, USER_ID).execute({
      lead_id: LEAD_ID,
      idempotency_key: "appointment-2026-09-24",
      greeting: "Hello, this is Acme.",
      objective: "Confirm tomorrow's appointment",
      additional_context: "The appointment starts at 10 AM.",
      language: "en-US",
      max_duration_minutes: 5,
    });

    expect(result).toMatchObject({
      success: true,
      call_id: "call-1",
      delivery_id: "delivery-1",
    });
    expect(placeTrackedVoiceCall).toHaveBeenCalledWith(expect.objectContaining({
      siteId: SITE_ID,
      to: "+5215551234567",
      leadId: LEAD_ID,
      greeting: "Hello, this is Acme.",
      objective: "Confirm tomorrow's appointment",
      additionalContext: "The appointment starts at 10 AM.",
      language: "en-US",
      maxDurationMinutes: 5,
    }));
  });

  it("rejects a lead from another site before creating records", async () => {
    (getLeadById as jest.Mock).mockResolvedValueOnce({
      id: LEAD_ID,
      site_id: "dddddddd-eeee-4fff-8000-111111111111",
      phone: "+5215551234567",
    });

    await expect(
      placeVoiceCallTool(SITE_ID).execute({
        lead_id: LEAD_ID,
        idempotency_key: "appointment-2026-09-24",
        greeting: "Hello.",
        objective: "Confirm the appointment",
      })
    ).rejects.toThrow("Lead was not found in this site");

    expect(supabaseAdmin.from).not.toHaveBeenCalled();
    expect(placeTrackedVoiceCall).not.toHaveBeenCalled();
  });

  it("reuses deterministic records when the same call is retried", async () => {
    const tool = placeVoiceCallTool(SITE_ID, USER_ID);
    const args = {
      lead_id: LEAD_ID,
      idempotency_key: "appointment-2026-09-24",
      greeting: "Hello, this is Acme.",
      objective: "Confirm the appointment",
    };

    await tool.execute(args);
    await tool.execute(args);

    const first = (placeTrackedVoiceCall as jest.Mock).mock.calls[0][0];
    const second = (placeTrackedVoiceCall as jest.Mock).mock.calls[1][0];
    expect(second.messageId).toBe(first.messageId);
    expect(second.conversationId).toBe(first.conversationId);
  });
});
