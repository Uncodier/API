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
const mockQueueInboundVoiceResponse = jest.fn();

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
  queueInboundVoiceResponse: (...args: unknown[]) =>
    mockQueueInboundVoiceResponse(...args),
}));

function mockSettingsForSender(siteId = "site-1") {
  const maybeSingle = jest.fn().mockResolvedValue({ data: { user_id: "user-1" } });
  (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
    if (table === "sites") {
      return { select: jest.fn().mockReturnValue({ eq: jest.fn().mockReturnValue({ maybeSingle }) }) };
    }
    return {
      select: jest.fn().mockReturnValue({
        contains: jest.fn().mockResolvedValue({
          data: [{ id: "settings-1", site_id: siteId, channels: { connections: [] } }],
          error: null,
        }),
      }),
    };
  });
}

describe("handleInboundMessage", () => {
  const customerSupportMessage = jest.fn().mockResolvedValue({ success: true, workflowId: "wf_1" });

  beforeEach(() => {
    jest.clearAllMocks();
    (WorkflowService.getInstance as jest.Mock).mockReturnValue({ customerSupportMessage });
  });

  it("starts the customerSupport workflow for a valid inbound channel", async () => {
    mockSettingsForSender("site-99");

    await handleInboundMessage({
      id: "evt_1",
      senderId: "snd_1",
      data: {
        from: "12345",
        channel: "telegram",
        text: "hola",
        messageId: "msg_1",
        profileName: "Ana",
      },
    });

    expect(customerSupportMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "hola",
        site_id: "site-99",
        origin: "telegram",
        phone: "12345",
        origin_message_id: "msg_1",
        channel_delivery: true,
      }),
      expect.any(Object)
    );
  });

  it("does not start a workflow when channel is missing", async () => {
    mockSettingsForSender();

    await handleInboundMessage({
      senderId: "snd_1",
      data: { from: "12345", text: "hola" },
    });

    expect(customerSupportMessage).not.toHaveBeenCalled();
  });

  it("uses a media placeholder instead of dropping inbound media without text", async () => {
    mockSettingsForSender("site-media");

    await handleInboundMessage({
      senderId: "snd_1",
      data: {
        from: "12345",
        channel: "telegram",
        messageType: "image",
        messageId: "msg_img",
      },
    });

    expect(customerSupportMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "[image]",
        origin: "telegram",
        origin_message_id: "msg_img",
      }),
      expect.any(Object)
    );
  });
});

describe("handleVoiceCallEvent", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (supabaseAdmin.schema as jest.Mock).mockReturnValue({
      from: supabaseAdmin.from,
    });
    mockHandleUntrackedInboundVoiceEvent.mockResolvedValue({ handled: false });
    mockQueueInboundVoiceResponse.mockResolvedValue(undefined);
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
      deliveryId: "delivery-1",
    });
  });

  it("retries an inbound response workflow that was not marked queued", async () => {
    const delivery = {
      id: "delivery-1",
      message_id: "message-1",
      site_id: "site-1",
      conversation_id: "conversation-1",
      lead_id: "lead-1",
      zavu_sender_id: "sender-1",
      recipient_phone: "+14155550100",
      status: "completed",
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
          update: jest.fn().mockReturnValue({
            eq: jest.fn().mockResolvedValue({ error: null }),
          }),
        };
      }
      throw new Error(`Unexpected table ${table}`);
    });

    await handleVoiceCallEvent({
      type: "call.completed",
      data: { callId: "call-1" },
    });

    expect(mockQueueInboundVoiceResponse).toHaveBeenCalledWith({
      call,
      delivery,
    });
  });
});
