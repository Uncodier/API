const mockFrom = jest.fn();
const mockPlaceVoiceCall = jest.fn();
const mockSetContactContext = jest.fn();
const mockClearContactContext = jest.fn();
const mockGetSenderAgent = jest.fn();
const mockUpdateAgent = jest.fn();
const mockBuildFollowUpContext = jest.fn();

jest.mock("@/lib/database/supabase-server", () => ({
  supabaseAdmin: { from: mockFrom },
}));
jest.mock("../voice-call-client", () => ({
  placeVoiceCall: mockPlaceVoiceCall,
}));
jest.mock("../contact-client", () => ({
  setVoiceCallContactContext: mockSetContactContext,
  clearVoiceCallContactContext: mockClearContactContext,
}));
jest.mock("../agent-client", () => ({
  getSenderAgent: mockGetSenderAgent,
  updateAgent: mockUpdateAgent,
}));
jest.mock("../voice-follow-up-context", () => ({
  buildVoiceFollowUpContext: mockBuildFollowUpContext,
}));

import { placeTrackedVoiceCall } from "../voice-call-service";

describe("placeTrackedVoiceCall idempotency", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSetContactContext.mockResolvedValue(undefined);
    mockClearContactContext.mockResolvedValue(undefined);
    mockGetSenderAgent.mockResolvedValue({
      id: "agent-1",
      includeContactMetadata: true,
    });
    mockUpdateAgent.mockResolvedValue({ id: "agent-1" });
    mockBuildFollowUpContext.mockResolvedValue({
      context: "Recent interactions: customer requested an afternoon appointment.",
      leadId: "lead-1",
      sources: { leadFound: true, messageCount: 2, transcriptCount: 1 },
    });
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
        command_status: 'success',
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

  it("loads private call guidance from the message and sends it as call metadata", async () => {
    const messageUpdates: Array<Record<string, any>> = [];
    mockPlaceVoiceCall.mockResolvedValue({
      id: "call-1",
      direction: "outbound",
      from: "+14155550100",
      to: "+5215551234567",
      status: "queued",
      createdAt: "2026-09-23T12:00:00.000Z",
    });
    mockFrom.mockImplementation((table: string) => {
      if (table === "messages") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockImplementation(() => ({
              eq: jest.fn().mockReturnValue({
                maybeSingle: jest.fn().mockResolvedValue({
                  data: {
                    conversation_id: "conversation-1",
                    lead_id: "lead-1",
                    custom_data: {
                      voice_objective: "Confirm the appointment",
                      voice_additional_context: "Offer the afternoon slot first.",
                    },
                  },
                  error: null,
                }),
              }),
              maybeSingle: jest.fn().mockResolvedValue({
                data: { custom_data: { status: "placing" } },
                error: null,
              }),
            })),
          }),
          update: jest.fn().mockImplementation((payload) => {
            messageUpdates.push(payload);
            return { eq: jest.fn().mockResolvedValue({ error: null }) };
          }),
        };
      }
      if (table === "voice_call_deliveries") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
            }),
          }),
          insert: jest.fn().mockResolvedValue({ error: null }),
          update: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({ eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockResolvedValue({ error: null }),
            }) }),
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
                    do_not_call: false,
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
      if (table === "settings") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              maybeSingle: jest.fn().mockResolvedValue({
                data: {
                  channels: {
                    connections: [{
                      type: "voice",
                      status: "connected",
                      zavu_sender_id: "sender-1",
                    }],
                  },
                },
                error: null,
              }),
            }),
          }),
        };
      }
      throw new Error(`Unexpected table ${table}`);
    });

    await placeTrackedVoiceCall({
      siteId: "site-1",
      to: "+5215551234567",
      greeting: "Hello",
      messageId: "message-1",
    });

    expect(mockPlaceVoiceCall).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        messageId: "message-1",
        objective: "Confirm the appointment",
        additionalContext: "Offer the afternoon slot first.",
      }),
    }));
    expect(mockBuildFollowUpContext).toHaveBeenCalledWith({
      siteId: "site-1",
      leadId: "lead-1",
      phone: "+5215551234567",
      excludeMessageId: "message-1",
    });
    expect(mockSetContactContext).toHaveBeenCalledWith(expect.objectContaining({
      phone: "+5215551234567",
      siteId: "site-1",
      objective: "Confirm the appointment",
      additionalContext: "Offer the afternoon slot first.",
      followUpContext:
        "Recent interactions: customer requested an afternoon appointment.",
    }));
    expect(messageUpdates).toContainEqual(expect.objectContaining({
      custom_data: expect.objectContaining({
        voice_follow_up_context:
          "Recent interactions: customer requested an afternoon appointment.",
        voice_follow_up_context_sources: {
          leadFound: true,
          messageCount: 2,
          transcriptCount: 1,
        },
      }),
    }));

    mockPlaceVoiceCall.mockRejectedValueOnce(new Error("network timeout"));
    await expect(placeTrackedVoiceCall({
      siteId: "site-1",
      to: "+5215551234567",
      greeting: "Hello",
      messageId: "message-2",
    })).rejects.toThrow("network timeout");
    expect(messageUpdates).toContainEqual(expect.objectContaining({
      custom_data: expect.objectContaining({
        status: "placement_unknown",
        call_status: "placement_unknown",
      }),
    }));

    mockSetContactContext.mockRejectedValueOnce(new Error("contact timeout"));
    await expect(placeTrackedVoiceCall({
      siteId: "site-1",
      to: "+5215551234567",
      greeting: "Hello",
      messageId: "message-3",
    })).rejects.toThrow("contact timeout");
    expect(messageUpdates).toContainEqual(expect.objectContaining({
      custom_data: expect.objectContaining({
        status: "failed",
        call_status: "failed",
      }),
    }));
  });

  it('pins optional selected site connection rather than the first voice sender and preserves terminal callbacks', async () => {
    const connections: any[] = [
      { id: 'first', type: 'voice', status: 'connected', zavu_sender_id: 'wrong-first' },
      { id: 'selected', type: 'voice', status: 'connected', zavu_sender_id: 'chosen-sender' },
    ];
    const lead: any = { phone: '+5215551234567', voice_call_consent_status: 'granted', voice_call_consent_at: '2026-09-21T12:00:00Z', do_not_call: false };
    let current: any = { outreach_activity: 'leads_initial_cold_outreach', outreach_delivery: { state: 'dispatching', attempt_id: 'attempt' } };
    const filters: any[] = []; const inserts: any[] = [];
    mockFrom.mockImplementation((table: string) => {
      const q: any = {
        select: () => q,
        eq: (key: string, value: string) => { filters.push([table, key, value]); return q; },
        maybeSingle: async () => ({ data: table === 'settings' ? { channels: { connections } } : table === 'leads' ? lead
          : table === 'messages' ? { conversation_id: 'conversation-1', lead_id: 'lead-1', custom_data: current } : null, error: null }),
        update: (payload: any) => { if (table === 'messages') current = payload.custom_data; return q; },
        insert: async (payload: any) => { inserts.push(payload); return { error: null }; },
        then: (resolve: any) => Promise.resolve(resolve({ error: null })),
      }; return q;
    });
    mockPlaceVoiceCall.mockImplementation(async () => {
      // Simulates a terminal webhook being persisted before placement returns.
      current = { ...current, voice_mode: 'agent_call', provider_call_id: 'call-exact', status: 'failed', call_status: 'no_answer', duration_seconds: 12 };
      return { id: 'call-exact', status: 'queued', to: lead.phone };
    });
    const input = { siteId: 'site-1', messageId: 'message-1', to: lead.phone, greeting: 'Hello', selectedConnectionId: 'selected', selectedSenderId: 'chosen-sender' };
    await expect(placeTrackedVoiceCall(input)).resolves.toMatchObject({ call: { id: 'call-exact' } });
    expect(mockPlaceVoiceCall).toHaveBeenCalledWith(expect.objectContaining({ senderId: 'chosen-sender' }));
    expect(inserts[0]).toMatchObject({ zavu_sender_id: 'chosen-sender', site_id: 'site-1' });
    expect(filters).toContainEqual(['settings', 'site_id', 'site-1']);
    expect(current).toMatchObject({ status: 'failed', command_status: 'failed', call_status: 'no_answer', duration_seconds: 12, outreach_delivery: { attempt_id: 'attempt' } });
    mockPlaceVoiceCall.mockClear();
    // Each following preflight assertion represents a fresh unsent message.
    current = { status: 'pending', command_status: 'pending' };
    await expect(placeTrackedVoiceCall({ ...input, selectedSenderId: 'wrong-first' })).rejects.toThrow('Selected Voice sender');
    connections[1].status = 'disconnected';
    await expect(placeTrackedVoiceCall(input)).rejects.toThrow('Selected Voice sender');
    connections[1].status = 'connected'; connections.push({ ...connections[1] });
    await expect(placeTrackedVoiceCall(input)).rejects.toThrow('Selected Voice sender');
    connections.pop(); lead.voice_call_consent_status = 'unknown';
    await expect(placeTrackedVoiceCall(input)).rejects.toThrow('explicit Voice call consent');
    expect(mockPlaceVoiceCall).not.toHaveBeenCalled();
  });
});
