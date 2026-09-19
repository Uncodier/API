const mockMaybeSingle = jest.fn();
const mockSyncAgent = jest.fn();
const mockSyncTools = jest.fn();

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

import { syncConnectedCustomerSupportVoiceAgent } from "../voice-sync";

describe("syncConnectedCustomerSupportVoiceAgent", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSyncAgent.mockResolvedValue({
      agent: { id: "agent_1" },
      webhookSecret: "whsec_test",
    });
    mockSyncTools.mockResolvedValue(undefined);
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
    });
    expect(mockSyncTools).toHaveBeenCalledWith({
      agentId: "agent_1",
      siteId: "site-1",
      webhookSecret: "whsec_test",
    });
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
  });
});
