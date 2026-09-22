import { NextRequest } from "next/server";

const mockPlaceTrackedVoiceCall = jest.fn();

jest.mock("@/lib/services/zavu/voice-call-service", () => ({
  placeTrackedVoiceCall: mockPlaceTrackedVoiceCall,
}));

import { POST } from "../route";

const VALID_BODY = {
  to: "+5215551234567",
  message: "Hello, this is Acme calling about your appointment.",
  site_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  message_id: "11111111-2222-4333-8444-555555555555",
  agent_id: "55555555-6666-4777-8888-999999999999",
  conversation_id: "22222222-3333-4444-8555-666666666666",
  lead_id: "33333333-4444-4555-8666-777777777777",
};

function request(body: unknown, service = true) {
  return new NextRequest("https://api.example.com/api/agents/tools/placeVoiceCall", {
    method: "POST",
    headers: service
      ? { "x-api-key-data": JSON.stringify({ isService: true }) }
      : undefined,
    body: JSON.stringify(body),
  });
}

describe("placeVoiceCall internal route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPlaceTrackedVoiceCall.mockResolvedValue({
      deliveryId: "44444444-5555-4666-8777-888888888888",
      duplicate: false,
      call: { id: "call_123", status: "queued" },
    });
  });

  it("requires the internal service principal", async () => {
    const response = await POST(request(VALID_BODY, false));

    expect(response.status).toBe(403);
    expect(mockPlaceTrackedVoiceCall).not.toHaveBeenCalled();
  });

  it("rejects malformed phone numbers", async () => {
    const response = await POST(request({ ...VALID_BODY, to: "5551234567" }));

    expect(response.status).toBe(400);
    expect(mockPlaceTrackedVoiceCall).not.toHaveBeenCalled();
  });

  it("places one tracked call", async () => {
    const response = await POST(request(VALID_BODY));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      callId: "call_123",
      status: "queued",
    });
    expect(mockPlaceTrackedVoiceCall).toHaveBeenCalledWith({
      siteId: VALID_BODY.site_id,
      to: VALID_BODY.to,
      greeting: VALID_BODY.message,
      messageId: VALID_BODY.message_id,
      conversationId: VALID_BODY.conversation_id,
      leadId: VALID_BODY.lead_id,
    });
  });
});
