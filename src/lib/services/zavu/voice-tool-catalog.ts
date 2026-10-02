import {
  getCustomerSupportToolDefinitions,
  type CustomerSupportToolDefinition,
} from "@/lib/services/customer-support-tool-catalog";

/** Voice has no browser visitor. Keep its identity contract separate from chat. */
export function getCustomerSupportVoiceToolDefinitions(
  siteId?: string
): CustomerSupportToolDefinition[] {
  const contextTool: CustomerSupportToolDefinition = {
    name: 'get_call_context',
    description: 'Load the purpose, direction and private context of THIS call before responding. No IDs needed; server binds the caller.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  };
  return [contextTool, ...getCustomerSupportToolDefinitions(siteId).map((tool) => {
    if (tool.name === "CONTACT_HUMAN") {
      const { conversation_id, lead_id, ...properties } = tool.parameters.properties as Record<string, unknown>;
      return {
        ...tool,
        description: "Request human assistance for this live call, even if identification failed. Call context is resolved by the server; never invent IDs. Success queues a request, not a live transfer.",
        parameters: {
          ...tool.parameters,
          properties,
          required: ["summary", "message", "priority"],
        },
      };
    }
    if (tool.name === "catalog_commerce") {
      return {
        ...tool,
        // Keep this first so it survives the runtime's 120-character summary.
        description: 'List services: action="list", resource="item", kind="service"; never resource="service". ' + tool.description,
      };
    }
    if (tool.name !== "IDENTIFY_LEAD") return tool;
    return {
      ...tool,
      description:
        "Identify the caller after explicit contact-storage consent. Confirm name and email first. Returns lead_id for scheduling and contact_details_saved; never claim details were saved when false. No visitor ID required.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Confirmed caller name" },
          email: {
            type: "string",
            description: "Read back and confirm the complete email, then send canonical format, e.g. ada.prado@me.com. Convert arroba/at to @ and punto/dot to .; join explicitly spelled letters (m e -> me). Never guess unclear spelling.",
          },
          phone: { type: "string", description: "Optional confirmed calling number in E.164. Must match the current call; omit if unknown. Never put an alternate contact number here." },
          callback_phone: { type: "string", description: "Optional alternate contact number, confirmed with country code in E.164. Stored as unverified contact metadata, never used to identify or merge leads or authorize outbound calls." },
          company: { type: "string", description: "Optional company name as text; omit if not supplied. Never request it just to satisfy this tool." },
          consent: {
            type: "boolean",
            description:
              "Set true only after the caller explicitly agrees to storing their contact details and being contacted. A call or caller ID alone is not consent.",
          },
        },
        required: ["name", "email", "consent"],
        additionalProperties: false,
      },
    };
  })];
}