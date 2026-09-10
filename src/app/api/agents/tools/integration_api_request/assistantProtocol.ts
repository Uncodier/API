import { integrationApiRequestCore } from "./core";
import type { IntegrationApiRequestParams } from "./core";

/**
 * Creates the integration_api_request tool for OpenAI/assistant compatibility.
 * Use this to make API calls using stored secrets without ever seeing the raw secret.
 */
export function integrationApiRequestTool(
  site_id: string,
  instance_id: string | null = null,
) {
  return {
    name: "integration_api_request",
    description:
      "Make an HTTP request to an external API using a securely stored secret (API key). The backend will inject the decrypted secret into the request headers automatically. You must first use list_site_secrets to find the ID of the secret you want to use.",
    parameters: {
      type: "object",
      properties: {
        secret_id: {
          type: "string",
          description:
            "The UUID of the secret (from list_site_secrets) to inject into this request.",
        },
        url: {
          type: "string",
          description:
            'The full URL for the API request (e.g., "https://api.openai.com/v1/chat/completions").',
        },
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
          description: "The HTTP method to use.",
        },
        headers: {
          type: "object",
          description:
            "Additional headers for the request (Content-Type is application/json by default). Do NOT include the secret here.",
        },
        body: {
          type: "object",
          description: "The JSON body of the request (for POST/PUT/PATCH).",
        },
        secret_header_name: {
          type: "string",
          description:
            'The name of the header where the secret should be injected. Defaults to "Authorization".',
        },
        secret_header_format: {
          type: "string",
          description:
            'The format of the header value, where "{secret}" will be replaced by the actual decrypted secret. Defaults to "Bearer {secret}". For a simple API key header like "x-api-key", just use "{secret}".',
        },
      },
      required: ["secret_id", "url", "method"],
    },
    execute: async (args: IntegrationApiRequestParams) => {
      const result = (await integrationApiRequestCore(
        site_id,
        instance_id,
        args,
      )) as any;
      // We don't automatically throw on !success here, because a 4xx response from the external API
      // is valid data the LLM might need to see (e.g. invalid arguments sent to the API).
      // If there's an internal error before the fetch, result.status won't exist.
      if (!result.success && result.error && !result.status) {
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
