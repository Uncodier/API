import {
  getCustomerSupportToolDefinitions,
  type CustomerSupportToolDefinition,
} from "@/lib/services/customer-support-tool-catalog";

/** Voice has no browser visitor. Keep its identity contract separate from chat. */
export function getCustomerSupportVoiceToolDefinitions(
  siteId?: string
): CustomerSupportToolDefinition[] {
  return getCustomerSupportToolDefinitions(siteId).map((tool) => {
    if (tool.name !== "IDENTIFY_LEAD") return tool;
    return {
      ...tool,
      description:
        "Identify the caller as a lead after explicit consent to store their contact details and be contacted. Confirm their name, email and phone first. No visitor ID is required. Returns lead_id for scheduling; never invent an ID.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Confirmed caller name" },
          email: { type: "string", description: "Confirmed caller email address" },
          phone: { type: "string", description: "Confirmed caller phone in E.164 format" },
          company: { type: "string", description: "Company name, if supplied by the caller" },
          consent: {
            type: "boolean",
            description:
              "Set true only after the caller explicitly agrees to storing their contact details and being contacted. A call or caller ID alone is not consent.",
          },
        },
        required: ["name", "email", "phone", "consent"],
        additionalProperties: false,
      },
    };
  });
}