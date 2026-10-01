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

  it("does not start a second agent for a Voice message echo", async () => {
    mockSettingsForSender();
    await handleInboundMessage({
      senderId: "snd_1",
      data: {
        from: "+14155550100", channel: "voice", text: "I need help",
      },
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

