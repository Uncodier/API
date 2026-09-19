import { deleteAgentTool, listAgentTools, upsertAgentTool } from "./agent-client";

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
}): Promise<void> {
  const retiredToolNames = new Set(["order_status", "book_reservation", "faq_knowledge"]);
  const existingTools = await listAgentTools(params.agentId);
  await Promise.all(
    existingTools
      .filter((tool) => retiredToolNames.has(tool.name))
      .map((tool) => deleteAgentTool(params.agentId, tool.id))
  );

  await upsertAgentTool(params.agentId, {
    ...CAPTURE_LEAD_TOOL,
    parameters: CAPTURE_LEAD_TOOL.parameters as unknown as Record<string, unknown>,
    webhookUrl: getVoiceToolWebhookUrl(params.siteId),
    webhookSecret: params.webhookSecret,
    enabled: true,
  });
}
