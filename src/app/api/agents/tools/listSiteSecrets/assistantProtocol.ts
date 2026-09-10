import { listSiteSecretsCore } from "./core";
import type { ListSiteSecretsParams } from "./core";

/**
 * Creates the list_site_secrets tool for OpenAI/assistant compatibility.
 * Use this to check which integrations are currently configured.
 */
export function listSiteSecretsTool(
  site_id: string,
  instance_id: string | null = null,
) {
  return {
    name: "list_site_secrets",
    description:
      "List the integrations, APIs, and secrets configured for this site/instance. This returns metadata like the ID, provider, use_case, and name, but NEVER the raw secret value. Use this tool to check if an API key (like OpenAI, Stripe, etc.) is available before trying to use it.",
    parameters: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          description:
            'Filter by a specific provider (e.g., "openai", "stripe").',
        },
        use_case: {
          type: "string",
          description:
            'Filter by a specific use case (e.g., "llm", "payments").',
        },
      },
      required: [],
    },
    execute: async (args: ListSiteSecretsParams) => {
      const result = (await listSiteSecretsCore(
        site_id,
        instance_id,
        args,
      )) as any;
      if (!result.success && result.error) {
        const errorMsg =
          typeof result.error === "string"
            ? result.error
            : (result.error as any).message || String(result.error);
        throw new Error(errorMsg);
      }
      return result;
    },
  };
}
