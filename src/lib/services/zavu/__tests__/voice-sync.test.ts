const mockMaybeSingle = jest.fn();
const mockSyncAgent = jest.fn();
const mockSyncTools = jest.fn();
const mockUpdateAgent = jest.fn();
const mockEnsureSenderWebhook = jest.fn();
const mockEnsureVoiceSender = jest.fn();
const mockEnsureEncryptedSenderWebhookSecret = jest.fn();
const mockUpdateSender = jest.fn();
const mockUpdatePrompt = jest.fn();
const mockRollbackAgent = jest.fn();
const mockAttachAgentSenders = jest.fn();
const mockUpsertConnection = jest.fn();
const mockRestoreConnections = jest.fn();

jest.mock("@/lib/database/supabase-server", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: mockMaybeSingle }),
      }),
    }),
  },
}));
jest.mock("../voice-agent", () => ({
  syncCustomerSupportVoiceAgent: mockSyncAgent,
  updateCustomerSupportVoicePrompt: mockUpdatePrompt,
  rollbackVoiceAgentSynchronization: mockRollbackAgent,
  attachCustomerSupportVoiceSenders: mockAttachAgentSenders,
}));
jest.mock("../voice-tools", () => ({
  syncVoiceTools: mockSyncTools,
}));
jest.mock("../agent-client", () => ({
  updateAgent: mockUpdateAgent,
}));
jest.mock("../client", () => ({
  ensureSenderWebhook: mockEnsureSenderWebhook,
  ensureVoiceSender: mockEnsureVoiceSender,
  updateSender: mockUpdateSender,
}));
jest.mock("../persist", () => ({
  upsertChannelConnection: mockUpsertConnection,
  restoreChannelConnections: mockRestoreConnections,
}));
jest.mock("../sender-webhook-secret", () => ({
  ensureEncryptedSenderWebhookSecret: mockEnsureEncryptedSenderWebhookSecret,
}));

import {
  syncConnectedCustomerSupportVoiceAgent,
  syncCustomerSupportVoiceAgentWithTools,
} from "../voice-sync";

describe("syncConnectedCustomerSupportVoiceAgent", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEnsureEncryptedSenderWebhookSecret.mockResolvedValue(
      "encrypted-webhook-secret"
    );
    mockSyncAgent.mockResolvedValue({
      agent: { id: "agent_1", enabled: false },
      webhookSecret: "whsec_test",
      shouldEnable: true,
      previousEnabled: true,
      previousAgentInput: {
        systemPrompt: "Previous prompt",
        enabled: true,
      },
      attachedSenderIds: [],
    });
    mockSyncTools.mockResolvedValue([
      {
        id: "tool_1",
        name: "reservations",
        description: "Manage reservations",
        parameters: {},
        enabled: true,
      },
    ]);
    mockUpdatePrompt.mockResolvedValue({ id: "agent_1", enabled: false });
    mockAttachAgentSenders.mockImplementation(async (synced) => synced);
    mockUpdateAgent.mockResolvedValue({ id: "agent_1", enabled: true });
    mockEnsureSenderWebhook.mockResolvedValue({
      id: "sender_1",
      channels: [],
      webhook: { events: ["call.completed", "call.failed"] },
    });
    mockEnsureVoiceSender.mockResolvedValue({
      id: "sender_1",
      channels: ["voice"],
      webhook: { events: ["call.completed", "call.failed"] },
    });
    mockUpdateSender.mockResolvedValue({ id: "sender_1" });
    mockUpsertConnection.mockResolvedValue({});
    mockRestoreConnections.mockResolvedValue({ connections: [] });
    mockRollbackAgent.mockResolvedValue(undefined);
  });

  it("syncs the agent and restores tools for connected Voice senders", async () => {
    mockMaybeSingle.mockResolvedValue({
      data: {
        channels: JSON.stringify({
          connections: [{
            id: "connection_1",
            type: "voice",
            status: "connected",
            zavu_sender_id: "sender_1",
            metadata: {},
          }],
        }),
      },
      error: null,
    });

    await expect(
      syncConnectedCustomerSupportVoiceAgent("site-1")
    ).resolves.toBe(true);
    expect(mockSyncAgent).toHaveBeenCalledWith({
      siteId: "site-1",
      senderIds: ["sender_1"],
      deferActivation: true,
      deferSenderAttachment: true,
      voicePreferences: undefined,
    });
    expect(mockSyncTools).toHaveBeenCalledWith({
      agentId: "agent_1",
      siteId: "site-1",
      webhookSecret: "whsec_test",
    });
    expect(mockUpdatePrompt).toHaveBeenCalledWith({
      siteId: "site-1",
      agentId: "agent_1",
      voicePreferences: undefined,
      voiceTools: expect.arrayContaining([
        expect.objectContaining({ name: "reservations" }),
      ]),
    });
    expect(mockEnsureSenderWebhook).toHaveBeenCalledWith("sender_1", {
      includeVoiceEvents: true,
    });
    expect(mockEnsureVoiceSender).toHaveBeenCalledWith("sender_1");
    expect(mockEnsureEncryptedSenderWebhookSecret).toHaveBeenCalledWith({
      senderId: "sender_1",
      returnedSecret: undefined,
      encryptedSecret: undefined,
    });
    expect(mockUpdateAgent).toHaveBeenCalledWith("agent_1", { enabled: true });
    expect(mockUpsertConnection).toHaveBeenCalledWith(
      "site-1",
      "connection_1",
      expect.objectContaining({
        status: "connected",
        metadata: expect.objectContaining({
          agent_enabled: true,
          activation_pending: false,
          zavu_webhook_secret: "encrypted-webhook-secret",
          webhook_events: ["call.completed", "call.failed"],
        }),
      })
    );
    expect(mockSyncTools.mock.invocationCallOrder[0])
      .toBeLessThan(mockUpdateAgent.mock.invocationCallOrder[0]);
    expect(mockSyncTools.mock.invocationCallOrder[0])
      .toBeLessThan(mockAttachAgentSenders.mock.invocationCallOrder[0]);
  });

  it("does nothing when the site has no connected Voice sender", async () => {
    mockMaybeSingle.mockResolvedValue({
      data: { channels: { connections: [] } },
      error: null,
    });

    await expect(
      syncConnectedCustomerSupportVoiceAgent("site-1")
    ).resolves.toBe(false);
    expect(mockSyncAgent).not.toHaveBeenCalled();
    expect(mockSyncTools).not.toHaveBeenCalled();
    expect(mockUpdateAgent).not.toHaveBeenCalled();
  });

  it("restores the existing agent state when tool registration fails", async () => {
    mockSyncTools.mockRejectedValueOnce(new Error("Tool registration failed"));

    await expect(
      syncCustomerSupportVoiceAgentWithTools({
        siteId: "site-1",
        senderIds: ["sender_1"],
      })
    ).rejects.toThrow("Tool registration failed");

    expect(mockRollbackAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        previousAgentInput: expect.objectContaining({
          systemPrompt: "Previous prompt",
        }),
      })
    );
  });

  it("leaves the staged agent disabled until the caller finalizes activation", async () => {
    await expect(
      syncCustomerSupportVoiceAgentWithTools({
        siteId: "site-1",
        senderIds: ["sender_1"],
        activate: false,
      })
    ).resolves.toMatchObject({
      agent: { id: "agent_1", enabled: false },
    });

    expect(mockUpdateAgent).not.toHaveBeenCalled();
    expect(mockUpdatePrompt).toHaveBeenCalled();
  });

  it("activates a pending Voice connection after its prerequisites are ready", async () => {
    mockMaybeSingle.mockResolvedValue({
      data: {
        channels: {
          connections: [{
            id: "connection_pending",
            type: "voice",
            status: "pending",
            zavu_sender_id: "sender_1",
            metadata: { regulatory_status: "approved" },
          }],
        },
      },
      error: null,
    });

    await expect(
      syncConnectedCustomerSupportVoiceAgent("site-1")
    ).resolves.toBe(true);

    expect(mockEnsureVoiceSender).toHaveBeenCalledWith("sender_1");
    expect(mockUpsertConnection).toHaveBeenCalledWith(
      "site-1",
      "connection_pending",
      expect.objectContaining({ status: "connected" })
    );
  });

  it("keeps regulatory-pending connections deferred without enabling Voice", async () => {
    mockMaybeSingle.mockResolvedValue({
      data: {
        channels: {
          connections: [{
            id: "connection_pending",
            type: "voice",
            status: "in_progress",
            zavu_sender_id: "sender_1",
            metadata: { regulatory_status: "pending_review" },
          }],
        },
      },
      error: null,
    });

    await expect(
      syncConnectedCustomerSupportVoiceAgent("site-1")
    ).resolves.toBe(true);

    expect(mockEnsureVoiceSender).not.toHaveBeenCalled();
    expect(mockUpsertConnection).toHaveBeenCalledWith(
      "site-1",
      "connection_pending",
      expect.objectContaining({
        status: "in_progress",
        metadata: expect.objectContaining({ activation_pending: true }),
      })
    );
  });
});
