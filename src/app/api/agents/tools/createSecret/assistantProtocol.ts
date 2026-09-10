import { createSecretCore } from "./core";
import type { CreateSecretParams } from "./core";

/**
 * Creates the create_site_secret tool for OpenAI/assistant compatibility.
 * Use this to securely store secrets, API keys, or tokens in site_secrets using AES-256 encryption.
 */
export function createSecretTool(
  site_id: string,
  instance_id: string | null = null,
) {
  return {
    name: "create_site_secret",
    description:
      "Store an API key, credential, or sensitive integration token securely. This encrypts the value before saving it to the database so it never persists in raw text. Use this when the user gives you a credential or after an OAuth flow. Returns the ID and metadata of the created secret, but NEVER the raw secret. You cannot read the secret back using this tool.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            'A recognizable name or alias for the secret (e.g. "STRIPE_PROD_KEY", "SENDGRID_API"). If this secret is used to inject an environment variable, use the exact ENV name.',
        },
        provider: {
          type: "string",
          description:
            'The service provider the secret belongs to (e.g., "stripe", "openai", "aws", "custom-api").',
        },
        use_case: {
          type: "string",
          description:
            'A short identifier for the use case (e.g., "payments", "llm", "storage").',
        },
        secret: {
          type: "string",
          description:
            "The actual sensitive secret value or API key to be securely stored. Pass the exact raw value, the tool will encrypt it.",
        },
      },
      required: ["name", "provider", "use_case", "secret"],
    },
    execute: async (args: CreateSecretParams) => {
      const result = await createSecretCore(site_id, instance_id, args);
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
