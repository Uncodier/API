import {
  deleteAgentTool,
  listAgentTools,
  upsertAgentTool,
  type ZavuAgentTool,
} from "./agent-client";
import {
  AUTO_VOICE_LANGUAGE,
  type VoiceAgentPreferences,
} from "./voice-preferences";

export const CAPTURE_LEAD_TOOL = {
  name: "capture_lead",
  description:
    "Capture a caller's name, phone number, and optional email address after they agree to be contacted.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Full name of the lead" },
      email: { type: "string", description: "Email address of the lead" },
      phone: { type: "string", description: "Phone number of the lead in E.164 format" },
    },
    required: ["name", "phone"],
  },
} as const;

export const MANAGED_VOICE_TOOLS = [CAPTURE_LEAD_TOOL] as const;

export interface VoicePromptTool {
  name: string;
  description: string;
  parameters: Record<string, any>;
  enabled?: boolean;
}

function describeToolInputs(tool: VoicePromptTool): string {
  const parameters = tool.parameters || {};
  const required = new Set<string>(
    Array.isArray(parameters.required) ? parameters.required : []
  );
  const properties =
    parameters.properties &&
    typeof parameters.properties === "object"
      ? parameters.properties
      : {};
  const inputs = Object.entries(properties).map(
    ([name, schema]: [string, any]) =>
      `${name}${required.has(name) ? " (required)" : " (optional)"}${
        schema.description ? `: ${schema.description}` : ""
      }`
  );
  return inputs.length > 0 ? ` Inputs: ${inputs.join("; ")}.` : "";
}

export function buildVoiceRuntimePrompt(
  preferences: VoiceAgentPreferences,
  tools: readonly VoicePromptTool[] = MANAGED_VOICE_TOOLS
): string {
  const languageInstruction =
    preferences.language === AUTO_VOICE_LANGUAGE
      ? "Detect the caller's language and continue in that language."
      : `The speech pipeline is configured for ${preferences.language}; conduct the call in that language.`;
  const toolList = tools
    .filter((tool) => tool.enabled !== false)
    .map((tool) => {
      return `- \`${tool.name}\`: ${tool.description}${describeToolInputs(tool)}`;
    })
    .join("\n");

  return [
    "# Voice Call Runtime",
    "You are speaking with a caller in a live, two-way phone conversation.",
    languageInstruction,
    "Use short, natural turns. Ask one clear question at a time, avoid markdown, and do not read URLs or internal identifiers aloud.",
    "Contact metadata may identify the caller. Confirm personal details before using or saving them, and never treat metadata as consent.",
    "",
    "# Available Voice Tools",
    toolList || "- No external tools are available.",
    "Only the tools listed above are callable in this channel. Do not claim that another integration or internal capability was executed.",
    "",
    "Tool policy:",
    "- Call a listed tool as soon as its action is needed and all required inputs are confirmed.",
    "- Do not merely promise to perform a tool-backed action; invoke the tool in the same turn.",
    "- For `capture_lead`, obtain the caller's clear agreement to be contacted, collect any missing required fields, confirm them, and then call the tool.",
    "- Never claim an action succeeded until the tool reports success.",
    "- If a tool fails, explain that the action could not be completed and offer a safe next step. Never invent a result.",
  ].join("\n");
}

export function getVoiceToolWebhookUrl(siteId: string): string {
  const baseUrl = process.env.API_SERVER_URL || process.env.NEXT_PUBLIC_API_SERVER_URL;
  if (!baseUrl) throw new Error("Missing API_SERVER_URL for the Zavu voice tool webhook");
  const url = new URL("/api/integrations/zavu/voice-tools", baseUrl);
  url.searchParams.set("siteId", siteId);
  if (url.protocol !== "https:" && process.env.NODE_ENV === "production") {
    throw new Error("The Zavu voice tool webhook must use HTTPS");
  }
  return url.toString();
}

export async function syncVoiceTools(params: {
  agentId: string;
  siteId: string;
  webhookSecret: string;
}): Promise<ZavuAgentTool[]> {
  const retiredToolNames = new Set(["order_status", "book_reservation", "faq_knowledge"]);
  const existingTools = await listAgentTools(params.agentId);
  const synchronizedTools: ZavuAgentTool[] = [];

  for (const tool of MANAGED_VOICE_TOOLS) {
    const synchronized = await upsertAgentTool(params.agentId, {
      ...tool,
      parameters: tool.parameters as unknown as Record<string, unknown>,
      webhookUrl: getVoiceToolWebhookUrl(params.siteId),
      webhookSecret: params.webhookSecret,
      enabled: true,
    });
    synchronizedTools.push({
      ...tool,
      ...synchronized,
      agentId: synchronized.agentId || params.agentId,
      parameters:
        synchronized.parameters ||
        (tool.parameters as unknown as Record<string, unknown>),
      webhookUrl:
        synchronized.webhookUrl || getVoiceToolWebhookUrl(params.siteId),
      webhookSecret: synchronized.webhookSecret || params.webhookSecret,
      enabled: synchronized.enabled ?? true,
    });
  }

  const retiredTools = existingTools.filter((tool) =>
    retiredToolNames.has(tool.name)
  );
  const deletionResults = await Promise.allSettled(
    retiredTools.map((tool) => deleteAgentTool(params.agentId, tool.id))
  );
  const retainedRetiredIds = new Set(
    deletionResults.flatMap((result, index) => {
      if (result.status === "fulfilled") return [];
      console.error(
        `[Zavu Voice] Failed to remove retired tool ${retiredTools[index].name}:`,
        result.reason
      );
      return [retiredTools[index].id];
    })
  );
  const managedNames = new Set<string>(
    MANAGED_VOICE_TOOLS.map((tool) => tool.name)
  );
  return [
    ...existingTools.filter(
      (tool) =>
        !managedNames.has(tool.name) &&
        (!retiredToolNames.has(tool.name) || retainedRetiredIds.has(tool.id))
    ),
    ...synchronizedTools,
  ];
}
