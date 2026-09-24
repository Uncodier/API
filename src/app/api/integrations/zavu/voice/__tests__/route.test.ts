const mockEnsureProjectWebhook = jest.fn();
const mockEnsureSenderWebhook = jest.fn();
const mockEnsureVoiceSender = jest.fn();
const mockEnsureEncryptedSenderWebhookSecret = jest.fn();
const mockSyncCustomerSupportVoiceAgentWithTools = jest.fn();
const mockSyncConnectedCustomerSupportVoiceAgent = jest.fn();
const mockUpsertChannelConnection = jest.fn();
const mockGetChannelConnection = jest.fn();
const mockGetCustomerSupportVoicePreferences = jest.fn();
const mockGetOwnedNumbers = jest.fn();
const mockPurchaseNumber = jest.fn();
const mockCreateSender = jest.fn();
const mockCreateVoiceSender = jest.fn();
const mockAssignPhoneNumberToSender = jest.fn();
const mockDeleteSender = jest.fn();
const mockRequireZavuSiteManager = jest.fn();
const mockRequireZavuSiteAccess = jest.fn();
const mockAssertPhoneResourcesAvailable = jest.fn();
const mockUpdateAgent = jest.fn();
const mockUpdateSender = jest.fn();
const mockUpdateAllVoiceConnectionPreferences = jest.fn();
const mockRollbackVoiceAgentSynchronization = jest.fn();
const mockRestoreChannelConnections = jest.fn();

jest.mock("@/lib/services/zavu", () => ({
  ensureProjectWebhook: mockEnsureProjectWebhook,
  ensureSenderWebhook: mockEnsureSenderWebhook,
  ensureVoiceSender: mockEnsureVoiceSender,
  ensureEncryptedSenderWebhookSecret: mockEnsureEncryptedSenderWebhookSecret,
  syncCustomerSupportVoiceAgentWithTools: mockSyncCustomerSupportVoiceAgentWithTools,
  syncConnectedCustomerSupportVoiceAgent: mockSyncConnectedCustomerSupportVoiceAgent,
  upsertChannelConnection: mockUpsertChannelConnection,
  getChannelConnection: mockGetChannelConnection,
  getCustomerSupportVoicePreferences: mockGetCustomerSupportVoicePreferences,
  getOwnedNumbers: mockGetOwnedNumbers,
  purchaseNumber: mockPurchaseNumber,
  createSender: mockCreateSender,
  createVoiceSender: mockCreateVoiceSender,
  assignPhoneNumberToSender: mockAssignPhoneNumberToSender,
  deleteSender: mockDeleteSender,
  requireZavuSiteManager: mockRequireZavuSiteManager,
  requireZavuSiteAccess: mockRequireZavuSiteAccess,
  assertPhoneResourcesAvailable: mockAssertPhoneResourcesAvailable,
  updateAgent: mockUpdateAgent,
  updateSender: mockUpdateSender,
  updateAllVoiceConnectionPreferences: mockUpdateAllVoiceConnectionPreferences,
  rollbackVoiceAgentSynchronization: mockRollbackVoiceAgentSynchronization,
  restoreChannelConnections: mockRestoreChannelConnections,
}));
import { NextRequest } from "next/server";
import { PATCH, POST } from "../route";
const SITE_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
function createVoiceRequest(body: Record<string, unknown>, headers?: HeadersInit) {
  return new NextRequest("https://backend.example.com/api/integrations/zavu/voice", {
    method: "POST",
    headers,
    body: JSON.stringify({ siteId: SITE_ID, ...body }),
  });
}

describe("Zavu Voice setup", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireZavuSiteManager.mockResolvedValue(undefined);
    mockRequireZavuSiteAccess.mockResolvedValue("member");
    mockAssertPhoneResourcesAvailable.mockResolvedValue(undefined);
    mockEnsureProjectWebhook.mockResolvedValue({});
    mockEnsureEncryptedSenderWebhookSecret.mockResolvedValue("encrypted-webhook-secret");
    mockGetChannelConnection.mockResolvedValue(null);
    mockGetCustomerSupportVoicePreferences.mockResolvedValue({ language: "auto" });
    mockGetOwnedNumbers.mockResolvedValue({
      items: [{
        id: "phone_1",
        phoneNumber: "+14155550100",
        senderId: "sender_1",
      }],
    });
    mockEnsureSenderWebhook.mockResolvedValue({
      id: "sender_1",
      channels: ["sms_oneway"],
      webhook: { events: ["message.inbound"] },
    });
    mockEnsureVoiceSender.mockImplementation(async (senderId: string) => ({
      id: senderId,
      channels: ["sms_oneway", "voice"],
      webhook: { events: ["message.inbound"] },
    }));
    mockSyncCustomerSupportVoiceAgentWithTools.mockResolvedValue({
      agent: { id: "agent_1", enabled: false },
      localAgentId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      webhookSecret: "whsec_test",
      shouldEnable: true,
      previousEnabled: true,
      previousAgentInput: {
        systemPrompt: "Previous prompt",
        enabled: true,
      },
      attachedSenderIds: [],
    });
    mockUpdateAgent.mockResolvedValue({ id: "agent_1", enabled: true });
    mockUpdateSender.mockResolvedValue({ id: "sender_1", channels: ["sms_oneway"] });
    mockRollbackVoiceAgentSynchronization.mockResolvedValue(undefined);
    mockRestoreChannelConnections.mockResolvedValue({ connections: [] });
    mockSyncConnectedCustomerSupportVoiceAgent.mockResolvedValue(true);
    mockCreateVoiceSender.mockResolvedValue({
      id: "sender_new",
      channels: [],
      webhook: { events: ["message.inbound"] },
    });
    mockCreateSender.mockResolvedValue({
      id: "sender_replacement",
      channels: ["sms_oneway"],
      webhook: { events: ["message.inbound"], secret: "whsec_sender" },
    });
    mockAssignPhoneNumberToSender.mockResolvedValue({});
    mockDeleteSender.mockResolvedValue(undefined);
    let persistedConnections: Array<Record<string, any>> = [];
    mockUpsertChannelConnection.mockImplementation(
      async (_siteId: string, channelId: string | undefined, patch: Record<string, any>) => {
        const persistedChannelId =
          channelId || "11111111-2222-4333-8444-555555555555";
        const connection = { id: persistedChannelId, ...patch };
        persistedConnections = [connection];
        return {
          channelId: persistedChannelId,
          connection,
          connections: [connection],
        };
      }
    );
    mockUpdateAllVoiceConnectionPreferences.mockImplementation(async () => ({
      connections: persistedConnections,
    }));
  });

  it("persists an in-progress connection before enabling the agent and Voice", async () => {
    const request = createVoiceRequest({
      channelId: "11111111-2222-4333-8444-555555555555",
      name: "Voice Support",
      phoneNumber: "+14155550100",
    }, { authorization: "Bearer user-token" });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.zavuAgentId).toBe("agent_1");
    expect(body.connection).toMatchObject({
      id: "11111111-2222-4333-8444-555555555555",
      status: "connected",
      metadata: {
        activation_pending: false,
        zavu_agent_id: "agent_1",
        zavu_webhook_secret: "encrypted-webhook-secret",
      },
    });
    expect(body.connections).toEqual([body.connection]);
    expect(mockSyncCustomerSupportVoiceAgentWithTools).toHaveBeenCalledWith({
      siteId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      senderIds: ["sender_1"],
      activate: false,
      voicePreferences: { language: "auto" },
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
    expect(mockEnsureSenderWebhook.mock.invocationCallOrder[0])
      .toBeLessThan(mockUpsertChannelConnection.mock.invocationCallOrder[0]);
    expect(mockUpsertChannelConnection).toHaveBeenNthCalledWith(
      1,
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "11111111-2222-4333-8444-555555555555",
      expect.objectContaining({ status: "in_progress" })
    );
    expect(mockUpsertChannelConnection.mock.invocationCallOrder[0])
      .toBeLessThan(mockSyncCustomerSupportVoiceAgentWithTools.mock.invocationCallOrder[0]);
    expect(mockSyncCustomerSupportVoiceAgentWithTools.mock.invocationCallOrder[0])
      .toBeLessThan(mockUpdateAgent.mock.invocationCallOrder[0]);
    expect(mockUpdateAgent.mock.invocationCallOrder[0])
      .toBeLessThan(mockEnsureVoiceSender.mock.invocationCallOrder[0]);
    expect(mockEnsureVoiceSender.mock.invocationCallOrder[0])
      .toBeLessThan(mockUpsertChannelConnection.mock.invocationCallOrder[1]);
  });

  it("rejects unauthenticated setup requests", async () => {
    mockRequireZavuSiteManager.mockRejectedValue(
      Object.assign(new Error("Unauthorized"), { status: 401 })
    );
    const request = createVoiceRequest({ phoneNumber: "+14155550100" });

    const response = await POST(request);

    expect(response.status).toBe(401);
    expect(mockEnsureSenderWebhook).not.toHaveBeenCalled();
  });

  it("rejects client-provided sender IDs", async () => {
    const request = createVoiceRequest({
      phoneNumber: "+14155550100",
      senderId: "sender_from_untrusted_client",
    });

    const response = await POST(request);

    expect(response.status).toBe(400);
    expect(mockEnsureSenderWebhook).not.toHaveBeenCalled();
  });

  it("creates a Voice sender when the owned number has no sender", async () => {
    mockGetOwnedNumbers.mockResolvedValue({
      items: [{ id: "phone_1", phoneNumber: "+14155550100" }],
    });

    const response = await POST(createVoiceRequest({
      phoneNumber: "+14155550100",
      name: "Voice Support",
    }));

    expect(response.status).toBe(200);
    expect(mockCreateVoiceSender).toHaveBeenCalledWith({
      name: "Voice Support",
      phoneNumber: "+14155550100",
    });
    expect(mockSyncCustomerSupportVoiceAgentWithTools).toHaveBeenCalledWith({
      siteId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      senderIds: ["sender_new"],
      activate: false,
      voicePreferences: { language: "auto" },
    });
  });

  it("replaces a missing sender before synchronizing the agent", async () => {
    mockEnsureSenderWebhook.mockRejectedValueOnce(
      Object.assign(new Error("Sender not found"), { status: 404 })
    );

    const response = await POST(createVoiceRequest({
      phoneNumber: "+14155550100",
    }));

    expect(response.status).toBe(200);
    expect(mockCreateSender).toHaveBeenCalledWith({
      name: "Voice aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      enableSmsOneway: true,
    });
    expect(mockAssignPhoneNumberToSender).toHaveBeenCalledWith(
      "phone_1",
      "sender_replacement"
    );
    expect(mockEnsureVoiceSender).toHaveBeenLastCalledWith("sender_replacement");
    expect(mockSyncCustomerSupportVoiceAgentWithTools).toHaveBeenCalledWith({
      siteId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      senderIds: ["sender_replacement"],
      activate: false,
      voicePreferences: { language: "auto" },
    });
    expect(mockUpsertChannelConnection).toHaveBeenLastCalledWith(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "11111111-2222-4333-8444-555555555555",
      expect.objectContaining({ status: "connected" }),
      {
        replaceSender: {
          previousSenderId: "sender_1",
          replacementSenderId: "sender_replacement",
        },
      }
    );
    expect(mockUpsertChannelConnection.mock.invocationCallOrder[1])
      .toBeGreaterThan(mockEnsureVoiceSender.mock.invocationCallOrder[0]);
  });

  it("persists numbers under regulatory review as in progress", async () => {
    mockGetOwnedNumbers.mockResolvedValue({
      items: [{
        id: "phone_1",
        phoneNumber: "+14155550100",
        senderId: "sender_1",
        regulatoryStatus: "pending_review",
      }],
    });

    const response = await POST(createVoiceRequest({
      phoneNumber: "+14155550100",
    }));

    expect(response.status).toBe(200);
    expect(mockUpsertChannelConnection).toHaveBeenCalledWith(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      undefined,
      expect.objectContaining({
        status: "in_progress",
        metadata: expect.objectContaining({
          regulatory_status: "pending_review",
        }),
      })
    );
    expect(mockEnsureVoiceSender).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      regulatoryStatus: "pending_review",
    });
  });

  it("does not enable Voice when agent or tool staging fails", async () => {
    mockGetOwnedNumbers.mockResolvedValue({
      items: [{ id: "phone_1", phoneNumber: "+14155550100" }],
    });
    mockSyncCustomerSupportVoiceAgentWithTools.mockRejectedValueOnce(
      new Error("Tool registration failed")
    );

    const response = await POST(createVoiceRequest({
      phoneNumber: "+14155550100",
    }));

    expect(response.status).toBe(502);
    expect(mockEnsureVoiceSender).not.toHaveBeenCalled();
    expect(mockUpsertChannelConnection).toHaveBeenCalledTimes(1);
    expect(mockDeleteSender).not.toHaveBeenCalled();
  });

  it("does not activate remote resources when staging persistence fails", async () => {
    mockUpsertChannelConnection.mockRejectedValueOnce(
      new Error("Failed to save connection in database")
    );

    const response = await POST(createVoiceRequest({
      phoneNumber: "+14155550100",
    }));

    expect(response.status).toBe(502);
    expect(mockSyncCustomerSupportVoiceAgentWithTools).not.toHaveBeenCalled();
    expect(mockUpdateAgent).not.toHaveBeenCalled();
    expect(mockEnsureVoiceSender).not.toHaveBeenCalled();
  });

  it("keeps inactive agents pending without enabling Voice", async () => {
    mockSyncCustomerSupportVoiceAgentWithTools.mockResolvedValueOnce({
      agent: { id: "agent_1", enabled: true },
      localAgentId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      webhookSecret: "whsec_test",
      shouldEnable: false,
      previousEnabled: true,
    });
    mockUpdateAgent.mockResolvedValueOnce({ id: "agent_1", enabled: false });

    const response = await POST(createVoiceRequest({
      phoneNumber: "+14155550100",
    }));

    expect(response.status).toBe(200);
    expect(mockEnsureVoiceSender).not.toHaveBeenCalled();
    expect(mockUpsertChannelConnection).toHaveBeenCalledTimes(2);
    expect(mockUpsertChannelConnection).toHaveBeenNthCalledWith(
      1,
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      undefined,
      expect.objectContaining({ status: "in_progress" })
    );
    expect(mockUpsertChannelConnection).toHaveBeenNthCalledWith(
      2,
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "11111111-2222-4333-8444-555555555555",
      expect.objectContaining({ status: "pending" }),
      undefined
    );
    await expect(response.json()).resolves.toMatchObject({ agentEnabled: false });
  });

  it("replaces sibling sender references when the local agent is inactive", async () => {
    mockEnsureSenderWebhook.mockRejectedValueOnce(
      Object.assign(new Error("Sender not found"), { status: 404 })
    );
    mockSyncCustomerSupportVoiceAgentWithTools.mockResolvedValueOnce({
      agent: { id: "agent_1", enabled: false },
      localAgentId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      webhookSecret: "whsec_test",
      shouldEnable: false,
      previousEnabled: false,
    });
    mockUpdateAgent.mockResolvedValueOnce({ id: "agent_1", enabled: false });

    const response = await POST(createVoiceRequest({
      phoneNumber: "+14155550100",
    }));

    expect(response.status).toBe(200);
    expect(mockUpsertChannelConnection).toHaveBeenLastCalledWith(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "11111111-2222-4333-8444-555555555555",
      expect.objectContaining({ status: "pending" }),
      {
        replaceSender: {
          previousSenderId: "sender_1",
          replacementSenderId: "sender_replacement",
        },
      }
    );
  });

  it("retains the staged record when final persistence and rollback fail", async () => {
    mockUpsertChannelConnection
      .mockResolvedValueOnce({
        channelId: "11111111-2222-4333-8444-555555555555",
      })
      .mockRejectedValueOnce(new Error("Final persistence failed"));
    mockUpdateSender.mockRejectedValueOnce(new Error("Sender rollback failed"));
    mockRollbackVoiceAgentSynchronization.mockRejectedValueOnce(
      new Error("Agent rollback failed")
    );

    const response = await POST(createVoiceRequest({
      phoneNumber: "+14155550100",
    }));

    expect(response.status).toBe(502);
    expect(mockUpsertChannelConnection).toHaveBeenNthCalledWith(
      1,
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      undefined,
      expect.objectContaining({ status: "in_progress" })
    );
    expect(mockUpsertChannelConnection.mock.invocationCallOrder[0])
      .toBeLessThan(mockEnsureVoiceSender.mock.invocationCallOrder[0]);
  });

  it("rolls back agent and Voice state when final Voice validation fails", async () => {
    mockEnsureVoiceSender.mockRejectedValueOnce(
      new Error("Zavu did not enable the Voice channel for the sender")
    );

    const response = await POST(createVoiceRequest({
      phoneNumber: "+14155550100",
    }));

    expect(response.status).toBe(502);
    expect(mockUpdateSender).toHaveBeenCalledWith("sender_1", {
      enableVoice: false,
    });
    expect(mockRollbackVoiceAgentSynchronization).toHaveBeenCalledWith(
      expect.objectContaining({
        previousAgentInput: expect.objectContaining({
          systemPrompt: "Previous prompt",
          enabled: true,
        }),
      })
    );
    expect(mockUpsertChannelConnection).toHaveBeenCalledTimes(1);
    expect(mockUpsertChannelConnection).toHaveBeenCalledWith(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      undefined,
      expect.objectContaining({ status: "in_progress" })
    );
  });

  it("runs the complete Voice synchronization during PATCH", async () => {
    const request = new NextRequest(
      "https://backend.example.com/api/integrations/zavu/voice",
      {
        method: "PATCH",
        headers: { authorization: "Bearer user-token" },
        body: JSON.stringify({
          siteId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        }),
      }
    );
    const response = await PATCH(request);
    expect(response.status).toBe(200);
    expect(mockSyncConnectedCustomerSupportVoiceAgent).toHaveBeenCalledWith(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    );
    await expect(response.json()).resolves.toEqual({
      success: true,
      synced: true,
    });
  });
});
