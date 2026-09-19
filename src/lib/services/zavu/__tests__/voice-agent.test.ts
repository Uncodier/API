const mockBuildAgentPrompt = jest.fn();
const mockGetSiteInfo = jest.fn();
const mockGetActiveCampaigns = jest.fn();
const mockGetAgentFiles = jest.fn();
const mockAppendAgentFiles = jest.fn();

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

import {
  buildCustomerSupportBackground,
  buildZavuAgentInput,
  fitZavuSystemPrompt,
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
