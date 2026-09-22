const mockFrom = jest.fn();
const mockPlaceVoiceCall = jest.fn();

jest.mock("@/lib/database/supabase-server", () => ({
  supabaseAdmin: { from: mockFrom },
}));
jest.mock("../voice-call-client", () => ({
  placeVoiceCall: mockPlaceVoiceCall,
}));

import { placeTrackedVoiceCall } from "../voice-call-service";

describe("placeTrackedVoiceCall idempotency", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("repairs message state before returning an existing provider call", async () => {
    const messageUpdate = jest.fn();
    let messageReads = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === "voice_call_deliveries") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              maybeSingle: jest.fn().mockResolvedValue({
                data: {
                  id: "delivery-1",
                  zavu_call_id: "call-1",
                  status: "queued",
                  recipient_phone: "+5215551234567",
                },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "messages") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockImplementation(() => ({
              eq: jest.fn().mockReturnValue({
                maybeSingle: jest.fn().mockResolvedValue({
                  data: {
                    conversation_id: "conversation-1",
                    lead_id: "lead-1",
                    custom_data: {},
                  },
                  error: null,
                }),
              }),
              maybeSingle: jest.fn().mockImplementation(async () => {
                messageReads += 1;
                return { data: { custom_data: { status: "sending" } }, error: null };
              }),
            })),
          }),
          update: jest.fn().mockImplementation((payload) => {
            messageUpdate(payload);
            return { eq: jest.fn().mockResolvedValue({ error: null }) };
          }),
        };
      }
      throw new Error(`Unexpected table ${table}`);
    });

    await expect(placeTrackedVoiceCall({
      siteId: "site-1",
      to: "+5215551234567",
      greeting: "Hello",
      messageId: "message-1",
    })).resolves.toMatchObject({ duplicate: true, deliveryId: "delivery-1" });

    expect(messageReads).toBe(1);
    expect(messageUpdate).toHaveBeenCalledWith(expect.objectContaining({
      custom_data: expect.objectContaining({
        status: "sent",
        voice_call_delivery_id: "delivery-1",
        provider_call_id: "call-1",
      }),
    }));
    expect(mockPlaceVoiceCall).not.toHaveBeenCalled();
  });

  it("blocks a new provider call when the lead is on the DNC list", async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === "messages") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                maybeSingle: jest.fn().mockResolvedValue({
                  data: {
                    conversation_id: "conversation-1",
                    lead_id: "lead-1",
                    custom_data: {},
                  },
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      if (table === "voice_call_deliveries") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              maybeSingle: jest.fn().mockResolvedValue({
                data: null,
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "leads") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                maybeSingle: jest.fn().mockResolvedValue({
                  data: {
                    phone: "+5215551234567",
                    do_not_call: true,
                    voice_call_consent_status: "granted",
                    voice_call_consent_at: "2026-09-21T12:00:00.000Z",
                  },
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      throw new Error(`Unexpected table ${table}`);
    });

    await expect(placeTrackedVoiceCall({
      siteId: "site-1",
      to: "+5215551234567",
      greeting: "Hello",
      messageId: "message-1",
    })).rejects.toMatchObject({
      message: "Lead is on the do-not-call list",
      status: 403,
    });
    expect(mockPlaceVoiceCall).not.toHaveBeenCalled();
  });
});
