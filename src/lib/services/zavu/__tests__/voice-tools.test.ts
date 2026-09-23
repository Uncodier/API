jest.mock("../agent-client", () => ({
  listAgentTools: jest.fn(),
  upsertAgentTool: jest.fn(),
  deleteAgentTool: jest.fn(),
}));

import {
  deleteAgentTool,
  listAgentTools,
  upsertAgentTool,
} from "../agent-client";
import { buildVoiceRuntimePrompt, syncVoiceTools } from "../voice-tools";

const mockListAgentTools = listAgentTools as jest.Mock;
const mockUpsertAgentTool = upsertAgentTool as jest.Mock;
const mockDeleteAgentTool = deleteAgentTool as jest.Mock;

describe("syncVoiceTools", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      API_SERVER_URL: "https://backend.makinari.com",
    };
    mockListAgentTools.mockResolvedValue([
      { id: "tool_old", name: "order_status" },
      { id: "tool_keep", name: "custom_tool" },
    ]);
    mockDeleteAgentTool.mockResolvedValue(undefined);
    mockUpsertAgentTool.mockResolvedValue({ id: "tool_capture" });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("removes retired mock tools and upserts capture_lead", async () => {
    const tools = await syncVoiceTools({
      agentId: "agent_1",
      siteId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      webhookSecret: "whsec_test",
    });

    expect(mockDeleteAgentTool).toHaveBeenCalledWith("agent_1", "tool_old");
    expect(mockDeleteAgentTool).not.toHaveBeenCalledWith("agent_1", "tool_keep");
    expect(mockUpsertAgentTool).toHaveBeenCalledWith(
      "agent_1",
      expect.objectContaining({
        name: "capture_lead",
        webhookUrl: expect.stringContaining("siteId=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"),
        webhookSecret: "whsec_test",
      })
    );
    expect(mockUpsertAgentTool.mock.invocationCallOrder[0])
      .toBeLessThan(mockDeleteAgentTool.mock.invocationCallOrder[0]);
    expect(tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "custom_tool" }),
    ]));
  });

  it("prompts the agent with live-call and tool execution rules", () => {
    const prompt = buildVoiceRuntimePrompt({ language: "es" });

    expect(prompt).toContain("live, two-way phone call");
    expect(prompt).toContain("override conflicting presentation or tool-use instructions");
    expect(prompt).toContain("configured for es");
    expect(prompt).toContain("`capture_lead`");
    expect(prompt).toContain("Never provide, spell out, read aloud, or offer to send links or URLs");
    expect(prompt).toContain("content that requires a screen");
    expect(prompt).toContain("silently check the listed tools");
    expect(prompt).toContain("Prefer that result over memory or guesswork");
    expect(prompt).toContain("never claim success before the tool confirms it");
    expect(prompt).toContain("clear consent to be contacted");
    expect(prompt.length).toBeLessThan(3_500);
  });

  it("documents every enabled provider tool in the final prompt", () => {
    const prompt = buildVoiceRuntimePrompt(
      { language: "auto" },
      [
        {
          name: "custom_tool",
          description: "Perform a custom supported action.",
          parameters: {
            properties: {
              reference: { description: "The confirmed reference." },
            },
            required: ["reference"],
          },
          enabled: true,
        },
      ]
    );

    expect(prompt).toContain("`custom_tool`");
    expect(prompt).toContain("Required inputs: reference.");
    expect(prompt).toContain("capability reference only");
    expect(prompt).not.toContain("For `capture_lead`");
  });

  it("does not encourage unavailable tool calls", () => {
    const prompt = buildVoiceRuntimePrompt(
      { language: "auto" },
      [{
        name: "disabled_tool",
        description: "This tool is disabled.",
        parameters: {},
        enabled: false,
      }]
    );

    expect(prompt).toContain("No external tools are available.");
    expect(prompt).toContain("No external tool is available.");
    expect(prompt).not.toContain("silently check the listed tools");
    expect(prompt).not.toContain("For `capture_lead`");
  });

  it("does not remove retired tools when managed tool registration fails", async () => {
    mockUpsertAgentTool.mockRejectedValueOnce(new Error("Registration failed"));

    await expect(syncVoiceTools({
      agentId: "agent_1",
      siteId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      webhookSecret: "whsec_test",
    })).rejects.toThrow("Registration failed");

    expect(mockDeleteAgentTool).not.toHaveBeenCalled();
  });
});
