const mockEnsureProjectWebhook = jest.fn();
const mockEnsureSenderWebhook = jest.fn();
const mockSyncCustomerSupportVoiceAgent = jest.fn();
const mockSyncConnectedCustomerSupportVoiceAgent = jest.fn();
const mockSyncVoiceTools = jest.fn();
const mockUpsertChannelConnection = jest.fn();
const mockGetOwnedNumbers = jest.fn();
const mockPurchaseNumber = jest.fn();
const mockCreateSender = jest.fn();
const mockAssignNumberToSender = jest.fn();
const mockRequireZavuSiteManager = jest.fn();
const mockRequireZavuSiteAccess = jest.fn();
const mockAssertPhoneResourcesAvailable = jest.fn();

jest.mock("@/lib/services/zavu", () => ({
  ensureProjectWebhook: mockEnsureProjectWebhook,
  ensureSenderWebhook: mockEnsureSenderWebhook,
  syncCustomerSupportVoiceAgent: mockSyncCustomerSupportVoiceAgent,
  syncConnectedCustomerSupportVoiceAgent: mockSyncConnectedCustomerSupportVoiceAgent,
  syncVoiceTools: mockSyncVoiceTools,
  upsertChannelConnection: mockUpsertChannelConnection,
  getOwnedNumbers: mockGetOwnedNumbers,
  purchaseNumber: mockPurchaseNumber,
  createSender: mockCreateSender,
  assignNumberToSender: mockAssignNumberToSender,
  requireZavuSiteManager: mockRequireZavuSiteManager,
  requireZavuSiteAccess: mockRequireZavuSiteAccess,
  assertPhoneResourcesAvailable: mockAssertPhoneResourcesAvailable,
}));

import { NextRequest } from "next/server";
import { PATCH, POST } from "../route";

describe("Zavu Voice setup", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireZavuSiteManager.mockResolvedValue(undefined);
    mockRequireZavuSiteAccess.mockResolvedValue("member");
    mockAssertPhoneResourcesAvailable.mockResolvedValue(undefined);
    mockEnsureProjectWebhook.mockResolvedValue({});
    mockGetOwnedNumbers.mockResolvedValue({
      items: [{
        id: "phone_1",
        phoneNumber: "+14155550100",
        senderId: "sender_1",
      }],
    });
    mockEnsureSenderWebhook.mockResolvedValue({
      id: "sender_1",
      webhook: { events: ["message.inbound"] },
    });
    mockSyncCustomerSupportVoiceAgent.mockResolvedValue({
      agent: { id: "agent_1", enabled: true },
      localAgentId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      webhookSecret: "whsec_test",
    });
    mockSyncVoiceTools.mockResolvedValue(undefined);
    mockSyncConnectedCustomerSupportVoiceAgent.mockResolvedValue(true);
    mockUpsertChannelConnection.mockResolvedValue({
      channelId: "11111111-2222-4333-8444-555555555555",
    });
  });

  it("creates or updates the agent before registering its tools", async () => {
    const request = new NextRequest("https://backend.example.com/api/integrations/zavu/voice", {
      method: "POST",
      headers: { authorization: "Bearer user-token" },
      body: JSON.stringify({
        siteId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        channelId: "11111111-2222-4333-8444-555555555555",
        name: "Voice Support",
        phoneNumber: "+14155550100",
      }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.zavuAgentId).toBe("agent_1");
    expect(mockSyncCustomerSupportVoiceAgent).toHaveBeenCalledWith({
      siteId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      senderIds: ["sender_1"],
    });
    expect(mockSyncVoiceTools).toHaveBeenCalledWith({
      agentId: "agent_1",
      siteId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      webhookSecret: "whsec_test",
    });
    expect(mockSyncCustomerSupportVoiceAgent.mock.invocationCallOrder[0])
      .toBeLessThan(mockSyncVoiceTools.mock.invocationCallOrder[0]);
    expect(mockEnsureSenderWebhook).toHaveBeenCalledWith("sender_1");
  });

  it("rejects unauthenticated setup requests", async () => {
    mockRequireZavuSiteManager.mockRejectedValue(
      Object.assign(new Error("Unauthorized"), { status: 401 })
    );
    const request = new NextRequest("https://backend.example.com/api/integrations/zavu/voice", {
      method: "POST",
      body: JSON.stringify({
        siteId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        phoneNumber: "+14155550100",
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(401);
    expect(mockEnsureSenderWebhook).not.toHaveBeenCalled();
  });

  it("rejects client-provided sender IDs", async () => {
    const request = new NextRequest(
      "https://backend.example.com/api/integrations/zavu/voice",
      {
        method: "POST",
        body: JSON.stringify({
          siteId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
          phoneNumber: "+14155550100",
          senderId: "sender_from_untrusted_client",
        }),
      }
    );

    const response = await POST(request);

    expect(response.status).toBe(400);
    expect(mockEnsureSenderWebhook).not.toHaveBeenCalled();
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
