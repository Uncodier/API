import { buildDateContextSection } from "@/lib/timezone/dateContext";

const mockGetSiteInfo = jest.fn();
const mockGetActiveCampaigns = jest.fn();
const mockGetAgentFiles = jest.fn();
const mockAppendAgentFiles = jest.fn();
const mockUpdateAgent = jest.fn();
const mockMaybeSingle = jest.fn();

jest.mock("@/lib/agentbase/services/agent/BackgroundServices/DataFetcher", () => ({
  DataFetcher: {
    getSiteInfo: mockGetSiteInfo,
    getActiveCampaigns: mockGetActiveCampaigns,
  },
}));
jest.mock("@/lib/agentbase/adapters/AgentService", () => ({
  AgentService: { getAgentFiles: mockGetAgentFiles },
}));
jest.mock("@/lib/agentbase/services/FileProcessingService", () => ({
  FileProcessingService: jest.fn().mockImplementation(() => ({
    appendAgentFilesToBackground: mockAppendAgentFiles,
  })),
}));
jest.mock("@/lib/timezone", () => ({
  resolveClientTimezone: jest.fn().mockResolvedValue("Europe/Madrid"),
  buildDateContextSection: (timezone: string) => buildDateContextSection(timezone),
}));
jest.mock("@/lib/database/supabase-server", () => ({
  supabaseAdmin: {
    from: () => {
      const query = {
        select: () => query,
        eq: () => query,
        order: () => query,
        limit: () => query,
        maybeSingle: mockMaybeSingle,
      };
      return query;
    },
  },
}));
jest.mock("../agent-client", () => ({ updateAgent: mockUpdateAgent }));
jest.mock("../client", () => ({}));
jest.mock("@/lib/utils/token-encryption", () => ({ encryptToken: jest.fn() }));
jest.mock("@/lib/utils/token-decryption", () => ({ decryptToken: jest.fn() }));

import {
  buildCustomerSupportBackground,
  updateCustomerSupportVoicePrompt,
  type CustomerSupportAgent,
} from "../voice-agent";
import { getCustomerSupportVoiceToolDefinitions } from "../voice-tool-catalog";
import { buildVoiceRuntimePrompt, VOICE_RUNTIME_REMINDER } from "../voice-tools";

const siteId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const agent: CustomerSupportAgent = {
  id: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
  name: "Support Assistant",
  description: "Customer care specialist",
  prompt: "Never promise refunds without approval.",
  backstory: "Experienced customer care team member.",
  status: "active",
  tools: {},
  activities: {},
  configuration: {},
};

function businessFixture() {
  return {
    site: {
      name: "Northstar Bikes",
      url: "https://northstar.example",
      description: "Bicycle repairs and rentals",
    },
    settings: {
      about: "Family-owned cycle workshop",
      company_size: "12 people",
      industry: "Cycling",
      business_model: { b2c: true },
      products: ["City bicycle"],
      services: ["Wheel alignment"],
      branding: { voice_and_tone: { communication_style: "Warm and practical" } },
      locations: [{ name: "Main workshop", city: "Madrid", address: "12 Example Street" }],
      goals: ["Build rider loyalty"],
      team_members: [{ name: "Morgan", role: "Workshop manager" }],
      team_roles: { repairs: "Mechanics" },
      org_structure: "Repairs report to Morgan",
      business_hours: { Monday: "09:00-18:00" },
      customer_journey: { retention: { tactics: ["Offer a maintenance check"] } },
    },
    copywriting: [],
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "log").mockImplementation(() => {});
  mockGetSiteInfo.mockResolvedValue(businessFixture());
  mockGetActiveCampaigns.mockResolvedValue([
    { title: "Autumn tune-up", description: "Seasonal maintenance service" },
  ]);
  mockGetAgentFiles.mockResolvedValue([]);
  mockMaybeSingle.mockResolvedValue({ data: agent, error: null });
  mockUpdateAgent.mockImplementation(async (id, input) => ({ id, ...input }));
});

afterEach(() => jest.restoreAllMocks());

it("includes business and team facts with the real AgentBase builder and no call context", async () => {
  const prompt = await buildCustomerSupportBackground(siteId, agent);

  for (const fact of [
    "Northstar Bikes", "Family-owned cycle workshop", "Cycling", "City bicycle",
    "Wheel alignment", "Warm and practical", "Main workshop", "Morgan",
    "Workshop manager", "Mechanics", "Repairs report to Morgan", "09:00-18:00",
    "Autumn tune-up", "Offer a maintenance check", "Build rider loyalty",
    "Never promise refunds without approval.",
  ]) {
    expect(prompt).toContain(fact);
  }
  expect(mockGetSiteInfo).toHaveBeenCalledWith(siteId);
  expect(mockGetActiveCampaigns).toHaveBeenCalledWith(siteId);
  expect(prompt).toContain("Europe/Madrid");
  expect(prompt).not.toContain("Server UTC:");
  expect(prompt).not.toContain("Precomputed UTC filter bounds");
  expect(prompt.length).toBeLessThanOrEqual(10_000);
});

it("keeps late business sections, campaigns and reference files despite oversized earlier text", async () => {
  mockGetSiteInfo.mockResolvedValue({
    ...businessFixture(),
    copywriting: [{
      status: "approved", copy_type: "website", title: "Workshop introduction",
      content: "Friendly local workshop. ".repeat(1_000),
    }],
  });
  mockGetAgentFiles.mockResolvedValue([{ id: "faq", file_path: "faq.md" }]);
  mockAppendAgentFiles.mockImplementation(async (background) =>
    `${background}\n\n## Reference Files\n### FAQ.md\nRepairs require an appointment. ${"Reference detail. ".repeat(1_000)}`
  );

  const prompt = await buildCustomerSupportBackground(siteId, {
    ...agent,
    backstory: "Long agent biography. ".repeat(1_000),
  });

  for (const fact of [
    "Northstar Bikes", "Family-owned cycle workshop", "Wheel alignment", "Morgan",
    "Workshop manager", "Mechanics", "09:00-18:00", "Autumn tune-up",
    "Workshop introduction", "Repairs require an appointment.",
  ]) expect(prompt).toContain(fact);
  expect(prompt).toContain("Additional business context omitted");
  expect(prompt.startsWith(buildVoiceRuntimePrompt({ language: "auto" }))).toBe(true);
  expect(prompt.endsWith(VOICE_RUNTIME_REMINDER)).toBe(true);
  expect(prompt.length).toBeLessThanOrEqual(10_000);
});

it("honors AgentBase configuration overrides without exposing integration configuration", async () => {
  const prompt = await buildCustomerSupportBackground(siteId, {
    ...agent,
    configuration: {
      description: "Configured care specialist",
      backstory: "Configured workshop background",
      systemPrompt: "Escalate safety complaints to the manager.",
      prompt: "Confirm the bicycle model before advising.",
      capabilities: ["Repair guidance"],
      zavu: { tool_webhook_secret: "do-not-include-secret" },
    },
  });

  for (const text of [
    "Configured care specialist", "Configured workshop background",
    "Escalate safety complaints to the manager.",
    "Confirm the bicycle model before advising.", "Repair guidance",
  ]) expect(prompt).toContain(text);
  expect(prompt).not.toContain(agent.prompt);
  expect(prompt).not.toContain("do-not-include-secret");
});

it("uses row defaults for empty or invalid configuration text and tolerates absent optional sources", async () => {
  mockGetSiteInfo.mockResolvedValue({ site: null, settings: null, copywriting: null });
  mockGetActiveCampaigns.mockResolvedValue([]);
  const prompt = await buildCustomerSupportBackground(siteId, {
    ...agent,
    configuration: { prompt: " ", description: {}, backstory: null, capabilities: "invalid" },
  }, { voiceTools: [] });

  expect(prompt).toContain(agent.prompt);
  expect(prompt).toContain(agent.description);
  expect(prompt).toContain(agent.backstory);
  expect(prompt).toContain("No external tools are available.");
  expect(prompt).not.toContain("Northstar Bikes");
});

it("sends business context and the actual tool catalog in the post-registration prompt update", async () => {
  const result = await updateCustomerSupportVoicePrompt({
    siteId,
    agentId: "voice-agent",
    voiceTools: getCustomerSupportVoiceToolDefinitions(siteId),
  });

  expect(mockUpdateAgent).toHaveBeenCalledWith("voice-agent", {
    systemPrompt: expect.stringContaining("Northstar Bikes"),
  });
  expect(result.systemPrompt).toContain("Workshop manager");
  for (const tool of getCustomerSupportVoiceToolDefinitions(siteId)) {
    expect(result.systemPrompt).toContain(`\`${tool.name}\``);
  }
  expect(result.systemPrompt).toContain("clear consent to be contacted");
  expect(result.systemPrompt).toContain("never claim success before the tool confirms it");
  expect(result.systemPrompt?.endsWith(VOICE_RUNTIME_REMINDER)).toBe(true);
});