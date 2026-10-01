import {
  handleInboundMessage,
  handleVoiceCallEvent,
  resolveVoiceCallWebhookStatus,
} from "../webhook-handlers";
import { supabaseAdmin } from "@/lib/database/supabase-server";
import { WorkflowService } from "@/lib/services/workflow-service";
import { clearVoiceCallContactContext } from "../contact-client";
import { getVoiceCall } from "../voice-call-client";

const mockHandleUntrackedInboundVoiceEvent = jest.fn();
const mockPersistVoiceTranscript = jest.fn();
const mockResolveLead = jest.fn();
const mockLinkLead = jest.fn();
jest.mock("../inbound-voice-lead", () => ({
  resolveInboundVoiceLead: (...args: unknown[]) => mockResolveLead(...args),
  linkInboundVoiceLead: (...args: unknown[]) => mockLinkLead(...args),
}));

jest.mock("@/lib/database/supabase-server", () => ({
  supabaseAdmin: {
    from: jest.fn(),
    schema: jest.fn(),
  },
}));

jest.mock("@/lib/services/workflow-service", () => ({
  WorkflowService: {
    getInstance: jest.fn(),
  },
}));

jest.mock("@/lib/utils/token-encryption", () => ({
  encryptToken: jest.fn((value) => `enc:${value}`),
}));

jest.mock("../client", () => ({
  attachSenderToAgent: jest.fn(),
  ensureSenderWebhook: jest.fn(),
  mapInvitationStatus: jest.fn((status) => (status === "completed" ? "connected" : status)),
}));
jest.mock("../voice-call-client", () => ({
  getVoiceCall: jest.fn(),
}));
jest.mock("../contact-client", () => ({
  clearVoiceCallContactContext: jest.fn(),
}));
jest.mock("../inbound-voice-context", () => ({
  handleUntrackedInboundVoiceEvent: (...args: unknown[]) =>
    mockHandleUntrackedInboundVoiceEvent(...args),
}));
jest.mock("../voice-transcript", () => ({
  persistVoiceTranscript: (...args: unknown[]) =>
    mockPersistVoiceTranscript(...args),
}));

describe("handleVoiceCallEvent", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (supabaseAdmin.schema as jest.Mock).mockReturnValue({
      from: supabaseAdmin.from,
    });
    mockHandleUntrackedInboundVoiceEvent.mockResolvedValue({ handled: false });
    mockPersistVoiceTranscript.mockResolvedValue(undefined);
    mockResolveLead.mockResolvedValue("lead-1");
    mockLinkLead.mockResolvedValue(undefined);
  });

  it("treats call.completed without a provider status as completed", () => {
    expect(resolveVoiceCallWebhookStatus(
      "call.completed",
      undefined,
      undefined,
      "in_progress"
    )).toBe("completed");
  });

  it("maps provider-only statuses to database-safe active statuses", () => {
    expect(resolveVoiceCallWebhookStatus(
      "call.initiated",
      "initiated",
      undefined,
      "queued"
    )).toBe("ringing");
    expect(resolveVoiceCallWebhookStatus(
      "call.answered",
      "answered",
      undefined,
      "ringing"
    )).toBe("in_progress");
  });

  it("hydrates an untracked inbound call instead of dropping it", async () => {
    (supabaseAdmin.from as jest.Mock).mockReturnValue({
      select: jest.fn().mockReturnValue({
        limit: jest.fn().mockReturnValue({
          eq: jest.fn().mockResolvedValue({ data: [], error: null }),
        }),
      }),
    });
    mockHandleUntrackedInboundVoiceEvent.mockResolvedValue({
      handled: true,
      call: {
        id: "call-inbound",
        direction: "inbound",
        from: "+14155550100",
        to: "+14155550999",
        status: "initiated",
        createdAt: "2026-09-23T12:00:00.000Z",
      },
    });

    await handleVoiceCallEvent({
      type: "call.initiated",
      senderId: "sender-1",
      data: { callId: "call-inbound" },
    });

    expect(mockHandleUntrackedInboundVoiceEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "call.initiated" }),
      "call-inbound"
    );
  });

  it("does not regress a terminal delivery on an out-of-order event", () => {
    expect(resolveVoiceCallWebhookStatus(
      "call.ringing",
      "ringing",
      undefined,
      "completed"
    )).toBe("completed");
  });

  it("retries a completed call while Zavu has not exposed its announced transcript", async () => {
    (getVoiceCall as jest.Mock).mockResolvedValue({
      id: "call-1", direction: "inbound", status: "completed", transcript: [],
    });
    (supabaseAdmin.from as jest.Mock).mockReturnValue({
      select: () => ({ limit: () => ({ eq: async () => ({
        data: [{ id: "delivery-1", status: "ringing" }], error: null,
      }) }) }),
    });

    await expect(handleVoiceCallEvent({
      type: "call.completed",
      data: { callId: "call-1", transcriptAvailable: true },
    })).rejects.toThrow("Voice transcript is not yet available");
  });

  it("preserves prior fields when a sparse completion event arrives", async () => {
    const deliveryUpdates: Record<string, unknown>[] = [];
    const messageUpdates: Array<Record<string, any>> = [];
    (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "voice_call_deliveries") {
        return {
          select: jest.fn().mockReturnValue({
            limit: jest.fn().mockReturnValue({
              eq: jest.fn().mockResolvedValue({
                data: [{
                  id: "delivery-1",
                  message_id: "message-1",
                  recipient_phone: "+14155550100",
                  status: "answered",
                  answered_at: "2026-09-21T12:00:00.000Z",
                }],
                error: null,
              }),
            }),
          }),
          update: jest.fn().mockImplementation((payload) => {
            deliveryUpdates.push(payload);
            const updateQuery = {
              not: jest.fn(),
              neq: jest.fn(),
              select: jest.fn(),
            };
            updateQuery.not.mockReturnValue(updateQuery);
            updateQuery.neq.mockReturnValue(updateQuery);
            updateQuery.select.mockReturnValue({
              maybeSingle: jest.fn().mockResolvedValue({
                data: { status: "completed" },
                error: null,
              }),
            });
            return { eq: jest.fn().mockReturnValue(updateQuery) };
          }),
        };
      }
      if (table === "messages") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              maybeSingle: jest.fn().mockResolvedValue({
                data: {
                  custom_data: {
                    status: "sending",
                    duration_seconds: 42,
                    transcript_available: true,
                    call_direction: "inbound",
                    voice_response_workflow_status: "queued",
                  },
                },
              }),
            }),
          }),
          update: jest.fn().mockImplementation((payload) => {
            messageUpdates.push(payload);
            return { eq: jest.fn().mockResolvedValue({ error: null }) };
          }),
        };
      }
      throw new Error(`Unexpected table ${table}`);
    });

    await handleVoiceCallEvent({
      type: "call.completed",
      data: { callId: "call-1" },
    });

    expect(deliveryUpdates[0]).toMatchObject({
      zavu_call_id: "call-1",
      status: "completed",
    });
    expect(deliveryUpdates[0]).not.toHaveProperty("answered_at");
    expect(deliveryUpdates[0]).not.toHaveProperty("transcript");
    expect(deliveryUpdates[0]).not.toHaveProperty("cost");
    expect(messageUpdates[0].custom_data).toMatchObject({
      status: "received",
      call_status: "completed",
      duration_seconds: 42,
      transcript_available: true,
    });
    expect(clearVoiceCallContactContext).toHaveBeenCalledWith({
      phone: "+14155550100",
      deliveryId: "call-1",
    });
  });

  it("materializes existing inbound transcripts without starting a response workflow", async () => {
    const conversationUpdate = jest.fn().mockReturnValue({
      eq: jest.fn().mockReturnValue({ eq: jest.fn().mockResolvedValue({ error: null }) }),
    });
    const messageUpdate = jest.fn().mockReturnValue({
      eq: jest.fn().mockResolvedValue({ error: null }),
    });
    const delivery = {
      id: "delivery-1",
      message_id: "message-1",
      site_id: "site-1",
      conversation_id: "conversation-1",
      lead_id: "lead-1",
      zavu_sender_id: "sender-1",
      recipient_phone: "+14155550100",
      status: "completed",
      transcript: [{ seq: 1, role: "user", text: "Please follow up." }],
    };
    const call = {
      id: "call-1",
      direction: "inbound",
      from: "+14155550100",
      to: "+14155550999",
      status: "completed",
      transcript: [{ seq: 1, role: "user", text: "Please follow up." }],
      createdAt: "2026-09-23T12:00:00.000Z",
    };
    (getVoiceCall as jest.Mock).mockResolvedValue(call);
    (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "voice_call_deliveries") {
        return {
          select: jest.fn().mockReturnValue({
            limit: jest.fn().mockReturnValue({
              eq: jest.fn().mockResolvedValue({
                data: [delivery],
                error: null,
              }),
            }),
          }),
          update: jest.fn().mockImplementation(() => {
            const updateQuery: any = {
              not: jest.fn(),
              neq: jest.fn(),
              select: jest.fn(),
            };
            updateQuery.not.mockReturnValue(updateQuery);
            updateQuery.neq.mockReturnValue(updateQuery);
            updateQuery.select.mockReturnValue({
              maybeSingle: jest.fn().mockResolvedValue({
                data: { status: "completed" },
                error: null,
              }),
            });
            return { eq: jest.fn().mockReturnValue(updateQuery) };
          }),
        };
      }
      if (table === "messages") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              maybeSingle: jest.fn().mockResolvedValue({
                data: {
                  custom_data: {
                    call_direction: "inbound",
                    voice_response_workflow_status: "pending",
                  },
                },
                error: null,
              }),
            }),
          }),
          update: messageUpdate,
        };
      }
      if (table === "conversations") {
        return {
          select: () => ({ eq: () => ({ eq: () => ({
            maybeSingle: async () => ({
              data: { custom_data: {
                voice_response_workflow_status: "pending", source: "zavu_inbound_voice",
              } },
              error: null,
            }),
          }) }) }),
          update: conversationUpdate,
        };
      }
      throw new Error(`Unexpected table ${table}`);
    });

    await handleVoiceCallEvent({
      type: "call.completed",
      data: { callId: "call-1" },
    });

    expect(conversationUpdate).toHaveBeenCalledWith({
      custom_data: { source: "zavu_inbound_voice" },
    });
    expect(messageUpdate).toHaveBeenCalledWith(expect.objectContaining({
      custom_data: expect.not.objectContaining({ voice_response_workflow_status: "pending" }),
    }));

    expect(mockPersistVoiceTranscript).toHaveBeenCalledWith({
      call: expect.objectContaining({
        id: "call-1",
        direction: "inbound",
        transcript: call.transcript,
      }),
      siteId: "site-1",
      conversationId: "conversation-1",
      deliveryId: "delivery-1",
      leadId: "lead-1",
      agentId: undefined,
    });
    expect(mockLinkLead).toHaveBeenCalledWith({ siteId: "site-1", conversationId: "conversation-1",
      deliveryId: "delivery-1", callId: "call-1", leadId: "lead-1" });
  });

  it("does not lose a completed transcript when Zavu contact cleanup fails", async () => {
    const delivery = {
      id: "delivery-1", message_id: "message-1", site_id: "site-1",
      conversation_id: "conversation-1", recipient_phone: "+14155550100",
      status: "completed", transcript: [{ seq: 0, role: "assistant", text: "Hello" }],
    };
    (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "voice_call_deliveries") return {
        select: () => ({ limit: () => ({ eq: async () => ({ data: [delivery], error: null }) }) }),
        update: () => ({ eq: () => ({ select: () => ({
          maybeSingle: async () => ({ data: { status: "completed" }, error: null }),
        }) }) }),
      };
      if (table === "messages") return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({
          data: { custom_data: { call_direction: "inbound" } }, error: null,
        }) }) }),
        update: () => ({ eq: async () => ({ error: null }) }),
      };
      if (table === "conversations") return {
        select: () => ({ eq: () => ({ eq: () => ({
          maybeSingle: async () => ({ data: { custom_data: {} }, error: null }),
        }) }) }),
      };
      throw new Error(`Unexpected table ${table}`);
    });
    (clearVoiceCallContactContext as jest.Mock).mockRejectedValueOnce(new Error("Zavu unavailable"));
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(handleVoiceCallEvent({
        type: "call.completed", data: { callId: "call-1" },
      })).resolves.toBeUndefined();
      expect(mockPersistVoiceTranscript).toHaveBeenCalledWith(expect.objectContaining({
        deliveryId: "delivery-1",
        leadId: "lead-1",
      }));
      expect(mockResolveLead).toHaveBeenCalledWith("site-1", "+14155550100");
      expect(clearVoiceCallContactContext).toHaveBeenCalledWith({
        phone: "+14155550100", deliveryId: "call-1",
      });
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("projects outbound call turns separately from the original campaign message", async () => {
    const delivery = {
      id: "delivery-2",
      message_id: "campaign-message",
      site_id: "site-1",
      conversation_id: "conversation-1",
      recipient_phone: "+14155550100",
      status: "completed",
      transcript: [{ seq: 0, role: "assistant", text: "Welcome" }],
    };
    (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "voice_call_deliveries") {
        return {
          select: () => ({ limit: () => ({ eq: async () => ({ data: [delivery], error: null }) }) }),
          update: () => ({ eq: () => ({
            select: () => ({ maybeSingle: async () => ({ data: { status: "completed" }, error: null }) }),
          }) }),
        };
      }
      if (table === "messages") {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({
            data: { custom_data: { call_direction: "outbound" } }, error: null,
          }) }) }),
          update: () => ({ eq: async () => ({ error: null }) }),
        };
      }
      throw new Error(`Unexpected table ${table}`);
    });

    await handleVoiceCallEvent({ type: "call.completed", data: { callId: "call-2" } });

    expect(mockPersistVoiceTranscript).toHaveBeenCalledWith({
      call: expect.objectContaining({ direction: "outbound", transcript: delivery.transcript }),
      siteId: "site-1",
      conversationId: "conversation-1",
      deliveryId: "delivery-2",
      leadId: undefined,
      agentId: undefined,
    });
    expect(mockResolveLead).not.toHaveBeenCalled();
    expect(mockLinkLead).not.toHaveBeenCalled();
  });

  it("links an existing inbound conversation to its verified local Voice agent", async () => {
    const agentUpdate = jest.fn().mockReturnValue({
      eq: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({ is: jest.fn().mockResolvedValue({ error: null }) }),
      }),
    });
    (getVoiceCall as jest.Mock).mockResolvedValue({
      id: "call-1", agentId: "zavu-agent-1", direction: "inbound", status: "completed",
      transcript: [{ seq: 0, role: "assistant", text: "Hello" }],
    });
    (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "voice_call_deliveries") return {
        select: () => ({ limit: () => ({ eq: async () => ({ data: [{
          id: "delivery-1", message_id: "message-1", site_id: "site-1",
          conversation_id: "conversation-1", recipient_phone: "+14155550100",
          status: "completed",
        }], error: null }) }) }),
        update: () => ({ eq: () => ({ select: () => ({
          maybeSingle: async () => ({ data: { status: "completed" }, error: null }),
        }) }) }),
      };
      if (table === "messages") return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({
          data: { custom_data: { call_direction: "inbound" } }, error: null,
        }) }) }),
        update: () => ({ eq: async () => ({ error: null }) }),
      };
      if (table === "agents") return {
        select: () => ({ eq: () => ({ eq: () => ({ limit: () => ({
          maybeSingle: async () => ({ data: { id: "local-agent-1" }, error: null }),
        }) }) }) }),
      };
      if (table === "conversations") return {
        update: agentUpdate,
        select: () => ({ eq: () => ({ eq: () => ({
          maybeSingle: async () => ({ data: { custom_data: {} }, error: null }),
        }) }) }),
      };
      throw new Error(`Unexpected table ${table}`);
    });

    await handleVoiceCallEvent({
      type: "call.completed", data: { callId: "call-1", transcriptAvailable: true },
    });

    expect(agentUpdate).toHaveBeenCalledWith({ agent_id: "local-agent-1" });
    expect(mockPersistVoiceTranscript).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "local-agent-1",
    }));
  });
});
