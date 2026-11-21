const mockBuildAgentPrompt = jest.fn();
const mockGetSiteInfo = jest.fn();
const mockGetActiveCampaigns = jest.fn();
const mockGetAgentFiles = jest.fn();
const mockAppendAgentFiles = jest.fn();
const mockAgentTable = jest.fn();
const mockMaybeSingle = jest.fn();
const mockPersistAgent = jest.fn();
const mockGetAgent = jest.fn();
const mockGetSenderAgent = jest.fn();
const mockCreateStandaloneAgent = jest.fn();
const mockUpdateAgent = jest.fn();
const mockAttachSenderToAgent = jest.fn();
const mockDetachSenderFromAgent = jest.fn();

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
    from: (...args: unknown[]) => mockAgentTable(...args),
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
  detachSenderFromAgent: mockDetachSenderFromAgent,
}));

import { inboundDatabase } from "./inbound-lead-test-database";
import {
  buildCustomerSupportBackground,
  buildZavuAgentInput,
  updateCustomerSupportVoicePreferences,
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

  it("preserves a final Voice guardrail when business context is truncated", () => {
    const reminder = "# Final Voice Response Check\nKeep responses speech-only.";
    const prompt = fitZavuSystemPrompt("a".repeat(12_000), reminder);

    expect(prompt).toHaveLength(10_000);
    expect(prompt).toContain("Additional business context omitted");
    expect(prompt.endsWith(reminder)).toBe(true);
  });

  it("omits language so Zavu uses automatic detection", () => {
    expect(buildZavuAgentInput(localAgent, "System prompt").voice).not.toHaveProperty(
      "language"
    );
  });

  it("applies persisted language and speaking voice preferences", () => {
    const input = buildZavuAgentInput({
      ...localAgent,
      configuration: {
        zavu: {
          voice: {
            language: "es",
            ttsVoiceId: "aura-2-celeste-es",
          },
        },
      },
    }, "System prompt");

    expect(input.voice).toMatchObject({
      language: "es",
      ttsVoiceId: "aura-2-celeste-es",
    });
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
    expect(background).toContain("# Voice Runtime Rules — Highest Priority");
    expect(background).toContain("`reservations`");
    expect(background).toContain("`IDENTIFY_LEAD`");
    expect(background.indexOf("# Voice Runtime Rules — Highest Priority")).toBeLessThan(
      background.indexOf("Base background")
    );
    expect(background.indexOf("# Final Voice Response Check")).toBeGreaterThan(
      background.indexOf("Base background")
    );
  });
});

describe("syncCustomerSupportVoiceAgent", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAgentTable.mockImplementation(() => {
      const query = {
        select: () => query, eq: () => query, or: () => query, order: () => query, limit: () => query,
        maybeSingle: mockMaybeSingle, update: () => ({ eq: mockPersistAgent }),
      };
      return query;
    });
    mockGetSiteInfo.mockResolvedValue({ site: {}, settings: {} });
    mockGetActiveCampaigns.mockResolvedValue([]);
    mockBuildAgentPrompt.mockReturnValue("Base background");
    mockGetAgentFiles.mockResolvedValue([]);
    mockPersistAgent.mockResolvedValue({ error: null });
    mockAttachSenderToAgent.mockResolvedValue({});
    mockDetachSenderFromAgent.mockResolvedValue({});
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
      provider: "zavu",
      model: "gpt-4o-mini",
      systemPrompt: "Old prompt",
      contextWindowMessages: 20,
      includeContactMetadata: true,
      triggerOnChannels: ["voice"],
      triggerOnMessageTypes: ["voice_call"],
      voice: {
        enabled: true,
        language: "en",
        ttsVoiceId: "voice-en",
      },
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

  it.each([null, {}, { agentOrigin: null }, { agentOrigin: 'other' }])(
    'writes preferences to the most recently updated legacy Support, even when inactive (configuration %j)',
    async configuration => {
      const base = { ...localAgent, site_id: 'site-1', role: 'Customer Support' };
      const independent = { ...base, id: 'custom', status: 'active', updated_at: 3,
        configuration: { agentOrigin: 'independent' } };
      const state = inboundDatabase(mockAgentTable, { agents: [independent,
        { ...base, id: 'older', status: 'active', updated_at: 1 },
        { ...base, id: 'legacy', status: 'inactive', updated_at: 2, configuration },
      ] });
      await updateCustomerSupportVoicePreferences('site-1', { language: 'es' });
      expect(state.tables.agents.find(row => row.id === 'legacy')?.configuration.zavu.voice.language).toBe('es');
      expect(state.tables.agents.find(row => row.id === 'older')?.configuration).toEqual({});
      expect(state.tables.agents.find(row => row.id === 'custom')?.configuration).toEqual({ agentOrigin: 'independent' });
    },
  );

  it('does not provision a provider agent when only an independent Support exists', async () => {
    inboundDatabase(mockAgentTable, { agents: [{ ...localAgent, site_id: 'site-1', role: 'Customer Support',
      configuration: { agentOrigin: 'independent' } }] });
    await expect(syncCustomerSupportVoiceAgent({ siteId: 'site-1', senderIds: ['sender_1'] }))
      .rejects.toThrow('Customer Support agent not found');
    expect(mockGetSiteInfo).not.toHaveBeenCalled();
    expect(mockCreateStandaloneAgent).not.toHaveBeenCalled();
    expect(mockUpdateAgent).not.toHaveBeenCalled();
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
      expect.objectContaining({
        name: "Customer Support",
        provider: "zavu",
        model: "gpt-4o-mini",
        systemPrompt: "Old prompt",
        enabled: true,
        contextWindowMessages: 20,
        includeContactMetadata: true,
        triggerOnChannels: ["voice"],
        triggerOnMessageTypes: ["voice_call"],
        voice: {
          enabled: true,
          language: "en",
          ttsVoiceId: "voice-en",
        },
      })
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

  it("treats an already-attached response as success after reconciliation", async () => {
    mockGetSenderAgent
      .mockReset()
      .mockRejectedValueOnce(
        Object.assign(new Error("Zavu agent not found"), { status: 404 })
      )
      .mockResolvedValueOnce({
        id: "agent_1",
        enabled: true,
        name: "Customer Support",
        systemPrompt: "Base background",
      });
    mockAttachSenderToAgent.mockRejectedValueOnce(
      Object.assign(new Error("An agent was already created for this sender"), {
        status: 400,
      })
    );

    const result = await syncCustomerSupportVoiceAgent({
      siteId: "site-1",
      senderIds: ["sender_1"],
      deferActivation: true,
    });

    expect(result.agent.id).toBe("agent_1");
    expect(result.attachedSenderIds).toEqual([]);
    expect(mockGetSenderAgent).toHaveBeenCalledTimes(2);
    expect(mockPersistAgent).toHaveBeenCalled();
  });

  it("accepts Zavu's same-agent attachment response as idempotent success", async () => {
    mockGetSenderAgent
      .mockReset()
      .mockRejectedValueOnce(
        Object.assign(new Error("Zavu agent not found"), { status: 404 })
      );
    mockAttachSenderToAgent.mockRejectedValueOnce(
      Object.assign(
        new Error("That sender is already connected to this agent"),
        { status: 400 }
      )
    );

    const result = await syncCustomerSupportVoiceAgent({
      siteId: "site-1",
      senderIds: ["sender_1"],
      deferActivation: true,
    });

    expect(result.agent.id).toBe("agent_1");
    expect(result.attachedSenderIds).toEqual([]);
    expect(mockGetSenderAgent).toHaveBeenCalledTimes(1);
    expect(mockPersistAgent).toHaveBeenCalled();
  });

  it("detaches newly attached senders and restores full agent state on failure", async () => {
    mockGetSenderAgent.mockRejectedValueOnce(
      Object.assign(new Error("Sender not found"), { status: 404 })
    );
    mockPersistAgent.mockResolvedValueOnce({
      error: new Error("Failed to persist mapping"),
    });

    await expect(syncCustomerSupportVoiceAgent({
      siteId: "site-1",
      senderIds: ["sender_1"],
      deferActivation: true,
    })).rejects.toThrow("Failed to persist the Zavu agent mapping");

    expect(mockDetachSenderFromAgent).toHaveBeenCalledWith(
      "sender_1",
      "agent_1"
    );
    expect(mockUpdateAgent).toHaveBeenLastCalledWith(
      "agent_1",
      expect.objectContaining({
        systemPrompt: "Old prompt",
        enabled: true,
        voice: {
          enabled: true,
          language: "en",
          ttsVoiceId: "voice-en",
        },
      })
    );
  });
});
