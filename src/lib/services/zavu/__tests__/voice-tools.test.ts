jest.mock("../agent-client", () => ({
  listAgentTools: jest.fn(),
  upsertAgentTool: jest.fn(),
  deleteAgentTool: jest.fn(),
}));

import { randomBytes } from "node:crypto";
import {
  deleteAgentTool,
  listAgentTools,
  upsertAgentTool,
} from "../agent-client";
import { getCustomerSupportToolDefinitions } from "../../customer-support-tool-catalog";
import { getCustomerSupportVoiceToolDefinitions } from "../voice-tool-catalog";
import { buildVoiceRuntimePrompt, syncVoiceTools } from "../voice-tools";

const mockListAgentTools = listAgentTools as jest.Mock;
const mockUpsertAgentTool = upsertAgentTool as jest.Mock;
const mockDeleteAgentTool = deleteAgentTool as jest.Mock;

describe("syncVoiceTools", () => {
  const originalEnv = process.env;
  let webhookSecret: string;

  beforeEach(() => {
    jest.clearAllMocks();
    webhookSecret = randomBytes(24).toString("hex");
    process.env = {
      ...originalEnv,
      API_SERVER_URL: "https://voice.example.invalid",
    };
    mockListAgentTools.mockResolvedValue([
      { id: "tool_capture", name: "capture_lead" },
      { id: "tool_old", name: "order_status" },
      { id: "tool_context", name: "get_call_context" },
      { id: "tool_keep", name: "custom_tool" },
    ]);
    mockDeleteAgentTool.mockResolvedValue(undefined);
    mockUpsertAgentTool.mockResolvedValue({ id: "tool_capture" });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("uses the complete Customer Support message tool catalog", () => {
    expect(getCustomerSupportToolDefinitions("site-1").map((tool) => tool.name))
      .toEqual([
        "skill_lookup",
        "catalog_commerce",
        "promotions",
        "reservations",
        "reservation_schedules",
        "block_calendar_time",
        "calendars",
        "scheduling",
        "checkout",
        "DELEGATE_CONVERSATION",
        "QUALIFY_LEAD",
        "CONTACT_HUMAN",
        "IDENTIFY_LEAD",
        "CREATE_TASK",
        "UPDATE_TASK",
        "GET_TASKS",
      ]);
  });

  it("replaces existing Voice tools with the Customer Support catalog", async () => {
    const tools = await syncVoiceTools({
      agentId: "agent_1",
      siteId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      webhookSecret,
    });

    expect(mockDeleteAgentTool).toHaveBeenCalledWith("agent_1", "tool_old");
    expect(mockDeleteAgentTool).not.toHaveBeenCalledWith("agent_1", "tool_context");
    expect(mockDeleteAgentTool).toHaveBeenCalledWith("agent_1", "tool_capture");
    expect(mockDeleteAgentTool).toHaveBeenCalledWith("agent_1", "tool_keep");
    expect(mockUpsertAgentTool).toHaveBeenCalledWith(
      "agent_1",
      expect.objectContaining({
        name: "reservations",
        webhookUrl: expect.stringContaining("siteId=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"),
        webhookSecret,
      })
    );
    expect(mockUpsertAgentTool).toHaveBeenCalledWith(
      "agent_1",
      expect.objectContaining({ name: "QUALIFY_LEAD" })
    );
    expect(mockUpsertAgentTool).toHaveBeenCalledWith(
      "agent_1",
      expect.objectContaining({ name: "GET_TASKS" })
    );
    expect(mockUpsertAgentTool).toHaveBeenCalledTimes(17);
    expect(mockUpsertAgentTool).toHaveBeenCalledWith(
      "agent_1",
      expect.objectContaining({
        name: "IDENTIFY_LEAD",
        parameters: expect.objectContaining({
          required: ["name", "email", "consent"],
        }),
      })
    );
    for (const [, tool] of mockUpsertAgentTool.mock.calls) {
      expect(tool.description.length).toBeLessThanOrEqual(500);
    }
    expect(mockUpsertAgentTool.mock.invocationCallOrder[0])
      .toBeLessThan(mockDeleteAgentTool.mock.invocationCallOrder[0]);
    expect(tools).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "custom_tool" }),
    ]));
  });

  it("requires explicit consent for voice without changing the chat contract", () => {
    const voice = getCustomerSupportVoiceToolDefinitions("site-1")
      .find((tool) => tool.name === "IDENTIFY_LEAD")!;
    const chat = getCustomerSupportToolDefinitions("site-1")
      .find((tool) => tool.name === "IDENTIFY_LEAD")!;

    expect(voice.parameters.required).toContain("consent");
    expect(voice.parameters.required).not.toContain("phone");
    expect(voice.parameters.properties).toHaveProperty("callback_phone");
    expect(voice.parameters.properties).toMatchObject({
      email: { description: expect.stringContaining("Read back and confirm") },
    });
    expect(chat.parameters.properties).not.toHaveProperty("callback_phone");
    expect(voice.parameters.properties).not.toHaveProperty("visitor_id");
    expect(voice.parameters.properties).not.toHaveProperty("conversation");
    expect(chat.parameters.required).not.toContain("consent");
    expect(chat.parameters.properties).toHaveProperty("conversation");
  });

  it("allows human assistance without identification or model-supplied IDs in voice only", () => {
    const voice = getCustomerSupportVoiceToolDefinitions().find(tool => tool.name === "CONTACT_HUMAN")!;
    const chat = getCustomerSupportToolDefinitions().find(tool => tool.name === "CONTACT_HUMAN")!;
    expect(voice.parameters.required).toEqual(["summary", "message", "priority"]);
    expect(voice.parameters.properties).not.toHaveProperty("conversation_id");
    expect(voice.parameters.properties).not.toHaveProperty("lead_id");
    expect(chat.parameters.required).toEqual(expect.arrayContaining(["conversation_id", "name", "email"]));
    expect(chat.parameters.properties).toHaveProperty("lead_id");
  });

  it("keeps all 17 tools and enum guidance through the provider's type/description-only roundtrip", async () => {
    mockUpsertAgentTool.mockImplementation(async (_agentId, input) => ({
      ...input,
      id: `tool_${input.name}`,
      parameters: JSON.parse(JSON.stringify({
        type: input.parameters.type,
        required: input.parameters.required,
        properties: Object.fromEntries(Object.entries(input.parameters.properties).map(([name, value]) => {
          const property = value as { type: string; description: string };
          return [name, { type: property.type, description: property.description }];
        })),
      })),
    }));
    const tools = await syncVoiceTools({ agentId: "agent_1", siteId: "site-1", webhookSecret });
    expect(tools.map((tool) => tool.name)).toEqual(getCustomerSupportVoiceToolDefinitions().map((tool) => tool.name));
    expect(tools).toHaveLength(17);
    const catalog = tools.find((tool) => tool.name === "catalog_commerce")!;
    const properties = catalog.parameters.properties as any;
    expect(properties.resource.enum).toBeUndefined();
    expect(properties.resource.description).toContain('Allowed values: "item", "modifier_group"');
    expect(properties.action.description).toContain('"create", "list", "get", "update", "delete"');
    const promotions = tools.find((tool) => tool.name === "promotions")!;
    expect(promotions.parameters.properties).toHaveProperty("channels.description", expect.stringContaining('"marketplace", "shop", "pos"'));
    const source = getCustomerSupportVoiceToolDefinitions().find((tool) => tool.name === "catalog_commerce")!;
    expect(source.parameters.properties).toHaveProperty("resource.enum", expect.arrayContaining(["item"]));
    const prompt = buildVoiceRuntimePrompt({ language: "auto" }, tools);
    expect(prompt).toContain('List services: action="list", resource="item", kind="service"; never resource="service".');
    expect(prompt.length).toBeLessThan(5_600);
  });

  it("prefixes service-list guidance in voice only, preserving every chat parameter contract", () => {
    const chat = getCustomerSupportToolDefinitions();
    const voice = getCustomerSupportVoiceToolDefinitions();
    for (const source of chat) {
      const projected = voice.find((tool) => tool.name === source.name)!;
      if (!["IDENTIFY_LEAD", "CONTACT_HUMAN"].includes(source.name)) expect(projected.parameters).toEqual(source.parameters);
      if (!["IDENTIFY_LEAD", "catalog_commerce", "CONTACT_HUMAN"].includes(source.name)) {
        expect(projected.description).toBe(source.description);
      }
    }
    expect(chat.find((tool) => tool.name === "catalog_commerce")!.description).not.toContain("List services:");
    expect(voice.find((tool) => tool.name === "catalog_commerce")!.description.slice(0, 120))
      .toContain('resource="item", kind="service"; never resource="service"');
  });

  it("prompts the agent with live-call and tool execution rules", () => {
    const prompt = buildVoiceRuntimePrompt({ language: "es" });

    expect(prompt).toContain("live, two-way phone call");
    expect(prompt).toContain("override conflicting presentation or tool-use instructions");
    expect(prompt).toContain("configured for es");
    expect(prompt).toContain("`reservations`");
    expect(prompt).toContain("`IDENTIFY_LEAD`");
    expect(prompt).toContain("makinari_voice_call_objective");
    expect(prompt).toContain("makinari_voice_follow_up_context");
    expect(prompt).toContain("private call-specific guidance");
    expect(prompt).toContain('First silently call get_call_context');
    expect(prompt).toContain('never guess or deny calling');
    expect(prompt).toContain("Never provide, spell out, read aloud, or offer to send links or URLs");
    expect(prompt).toContain("content that requires a screen");
    expect(prompt).toContain("silently check the listed tools");
    expect(prompt).toContain("Prefer that result over memory or guesswork");
    expect(prompt).toContain("never claim success before the tool confirms it");
    expect(prompt).toContain("clear consent to be contacted");
    expect(prompt).toContain("Read back the full address and get confirmation");
    expect(prompt).toContain("invalid_fields");
    expect(prompt).toContain("On invalid_fields, fix only those fields; never retry unchanged input");
    expect(prompt).toContain("callback_phone with a confirmed country code");
    expect(prompt).toContain("contact_details_saved=false");
    expect(prompt).toContain("contact_review_required=true");
    expect(prompt).toContain("review is internal, not failure");
    expect(prompt.length).toBeLessThan(5_600);
    expect(buildVoiceRuntimePrompt({ language: "auto" }).length).toBeLessThan(5_600);
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
    expect(prompt).not.toContain("For `IDENTIFY_LEAD`");
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
    expect(prompt).not.toContain("For `IDENTIFY_LEAD`");
  });

  it("does not remove unmanaged tools when managed tool registration fails", async () => {
    mockUpsertAgentTool.mockRejectedValueOnce(new Error("Registration failed"));

    await expect(syncVoiceTools({
      agentId: "agent_1",
      siteId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      webhookSecret,
    })).rejects.toThrow("Registration failed");

    expect(mockDeleteAgentTool).not.toHaveBeenCalled();
  });
});
