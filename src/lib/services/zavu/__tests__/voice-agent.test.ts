const mockBuildAgentPrompt = jest.fn();
const mockGetSiteInfo = jest.fn();
const mockGetActiveCampaigns = jest.fn();
const mockGetAgentFiles = jest.fn();
const mockAppendAgentFiles = jest.fn();
const mockMaybeSingle = jest.fn();
const mockPersistAgent = jest.fn();
const mockGetAgent = jest.fn();
const mockGetSenderAgent = jest.fn();
const mockCreateStandaloneAgent = jest.fn();
const mockUpdateAgent = jest.fn();
const mockAttachSenderToAgent = jest.fn();

jest.mock(
  "@/lib/agentbase/services/agent/BackgroundServices/BackgroundBuilder",
  () => ({ BackgroundBuilder: { buildAgentPrompt: mockBuildAgentPrompt } })
);
jest.mock(
  "@/lib/agentbase/services/agent/BackgroundServices/DataFetcher",
  () => ({
    DataFetcher: {
      getSiteInfo: mockGetSiteInfo,
      getActiveCampaigns: mockGetActiveCampaigns,
    },
  })
);
jest.mock("@/lib/agentbase/adapters/AgentService", () => ({
  AgentService: { getAgentFiles: mockGetAgentFiles },
}));
jest.mock("@/lib/agentbase/services/FileProcessingService", () => ({
  FileProcessingService: jest.fn().mockImplementation(() => ({
    appendAgentFilesToBackground: mockAppendAgentFiles,
  })),
}));
jest.mock("@/lib/timezone", () => ({
  resolveClientTimezone: jest.fn().mockResolvedValue("UTC"),
}));
jest.mock("@/lib/database/supabase-server", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            order: () => ({
              limit: () => ({ maybeSingle: mockMaybeSingle }),
            }),
          }),
        }),
      }),
      update: () => ({ eq: mockPersistAgent }),
    }),
  },
}));
jest.mock("@/lib/utils/token-encryption", () => ({
  encryptToken: (value: string) => `encrypted:${value}`,
}));
jest.mock("@/lib/utils/token-decryption", () => ({
  decryptToken: (value: string) => value.replace("encrypted:", ""),
}));
jest.mock("../agent-client", () => ({
  getAgent: mockGetAgent,
  getSenderAgent: mockGetSenderAgent,
  createStandaloneAgent: mockCreateStandaloneAgent,
  updateAgent: mockUpdateAgent,
}));
jest.mock("../client", () => ({
  attachSenderToAgent: mockAttachSenderToAgent,
}));

import {
  buildCustomerSupportBackground,
  buildZavuAgentInput,
  fitZavuSystemPrompt,
  syncCustomerSupportVoiceAgent,
  type CustomerSupportAgent,
} from "../voice-agent";

const localAgent: CustomerSupportAgent = {
  id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  name: "Customer Support",
  description: "Helps customers",
  prompt: "Answer accurately.",
  backstory: null,
  status: "active",
  tools: {},
  activities: {},
  configuration: {},
};

describe("fitZavuSystemPrompt", () => {
  it("keeps prompts within Zavu's 10,000 character limit", () => {
    const prompt = fitZavuSystemPrompt("a".repeat(12_000));

    expect(prompt).toHaveLength(10_000);
    expect(prompt).toContain("Additional business context omitted");
  });

  it("does not modify prompts already within the limit", () => {
    expect(fitZavuSystemPrompt("Customer support context")).toBe(
      "Customer support context"
    );
  });

  it("omits language so Zavu uses automatic detection", () => {
    expect(buildZavuAgentInput(localAgent, "System prompt").voice).not.toHaveProperty(
      "language"
    );
  });

  it("adds linked and configured files to the synchronized background", async () => {
    mockGetSiteInfo.mockResolvedValue({ site: {}, settings: {} });
    mockGetActiveCampaigns.mockResolvedValue([]);
    mockBuildAgentPrompt.mockReturnValue("Base background");
    mockGetAgentFiles.mockResolvedValue([
      { id: "asset-1", name: "FAQ.md", file_path: "faq.md" },
    ]);
    mockAppendAgentFiles.mockResolvedValue("Base background\n\nFAQ content");

    const background = await buildCustomerSupportBackground("site-1", {
      ...localAgent,
      configuration: {
        contextFiles: [{ id: "asset-2", name: "Policy.txt", path: "policy.txt" }],
      },
    });

    expect(mockAppendAgentFiles).toHaveBeenCalledWith("Base background", [
      { id: "asset-1", name: "FAQ.md", file_path: "faq.md" },
      { id: "asset-2", name: "Policy.txt", path: "policy.txt", file_path: "policy.txt" },
    ]);
    expect(background).toContain("FAQ content");
  });
});

describe("syncCustomerSupportVoiceAgent", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSiteInfo.mockResolvedValue({ site: {}, settings: {} });
    mockGetActiveCampaigns.mockResolvedValue([]);
    mockBuildAgentPrompt.mockReturnValue("Base background");
    mockGetAgentFiles.mockResolvedValue([]);
    mockPersistAgent.mockResolvedValue({ error: null });
    mockMaybeSingle.mockResolvedValue({
      data: {
        ...localAgent,
        configuration: { zavu: { agent_id: "agent_1" } },
      },
      error: null,
    });
    mockGetAgent.mockResolvedValue({
      id: "agent_1",
      enabled: true,
      name: "Customer Support",
      systemPrompt: "Old prompt",
    });
    mockUpdateAgent
      .mockResolvedValueOnce({
        id: "agent_1",
        enabled: true,
        name: "Customer Support",
        systemPrompt: "Base background",
      })
      .mockResolvedValueOnce({
        id: "agent_1",
        enabled: true,
        name: "Customer Support",
        systemPrompt: "Base background",
      });
  });

  it("restores an existing agent when sender validation fails", async () => {
    mockGetSenderAgent.mockResolvedValue({
      id: "agent_other",
      enabled: true,
      name: "Shared Agent",
      systemPrompt: "Shared",
    });

    await expect(
      syncCustomerSupportVoiceAgent({
        siteId: "site-1",
        senderIds: ["sender_1"],
        deferActivation: true,
      })
    ).rejects.toThrow("Sender sender_1 already belongs to another Zavu agent");

    expect(mockUpdateAgent).toHaveBeenNthCalledWith(
      1,
      "agent_1",
      expect.objectContaining({ enabled: true })
    );
    expect(mockUpdateAgent).toHaveBeenNthCalledWith(
      2,
      "agent_1",
      { enabled: true }
    );
    expect(mockPersistAgent).not.toHaveBeenCalled();
  });

  it("disables an inactive local agent before attaching a new sender", async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: {
        ...localAgent,
        status: "inactive",
        configuration: { zavu: { agent_id: "agent_1" } },
      },
      error: null,
    });
    mockUpdateAgent.mockReset().mockResolvedValue({
      id: "agent_1",
      enabled: false,
      name: "Customer Support",
      systemPrompt: "Base background",
    });
    mockGetSenderAgent.mockRejectedValueOnce(
      Object.assign(new Error("Sender not found"), { status: 404 })
    );

    await syncCustomerSupportVoiceAgent({
      siteId: "site-1",
      senderIds: ["sender_1"],
      deferActivation: true,
    });

    expect(mockUpdateAgent).toHaveBeenCalledWith(
      "agent_1",
      expect.objectContaining({ enabled: false })
    );
    expect(mockUpdateAgent.mock.invocationCallOrder[0])
      .toBeLessThan(mockAttachSenderToAgent.mock.invocationCallOrder[0]);
  });
});
