const mockMaybeSingle = jest.fn();
const mockSyncAgent = jest.fn();
const mockSyncTools = jest.fn();
const mockUpdateAgent = jest.fn();
const mockEnsureSenderWebhook = jest.fn();

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
}));
jest.mock("../voice-tools", () => ({
  syncVoiceTools: mockSyncTools,
}));
jest.mock("../agent-client", () => ({
  updateAgent: mockUpdateAgent,
}));
jest.mock("../client", () => ({
  ensureSenderWebhook: mockEnsureSenderWebhook,
}));

import {
  syncConnectedCustomerSupportVoiceAgent,
  syncCustomerSupportVoiceAgentWithTools,
} from "../voice-sync";

describe("syncConnectedCustomerSupportVoiceAgent", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSyncAgent.mockResolvedValue({
      agent: { id: "agent_1", enabled: false },
      webhookSecret: "whsec_test",
      shouldEnable: true,
      previousEnabled: true,
    });
    mockSyncTools.mockResolvedValue(undefined);
    mockUpdateAgent.mockResolvedValue({ id: "agent_1", enabled: true });
    mockEnsureSenderWebhook.mockResolvedValue({ id: "sender_1" });
  });

  it("syncs the agent and restores tools for connected Voice senders", async () => {
    mockMaybeSingle.mockResolvedValue({
      data: {
        channels: JSON.stringify({
          connections: [{
            type: "voice",
            status: "connected",
            zavu_sender_id: "sender_1",
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
    });
    expect(mockSyncTools).toHaveBeenCalledWith({
      agentId: "agent_1",
      siteId: "site-1",
      webhookSecret: "whsec_test",
    });
    expect(mockEnsureSenderWebhook).toHaveBeenCalledWith("sender_1");
    expect(mockUpdateAgent).toHaveBeenCalledWith("agent_1", { enabled: true });
    expect(mockSyncTools.mock.invocationCallOrder[0])
      .toBeLessThan(mockUpdateAgent.mock.invocationCallOrder[0]);
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

    expect(mockUpdateAgent).toHaveBeenCalledWith("agent_1", { enabled: true });
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
  });
});
