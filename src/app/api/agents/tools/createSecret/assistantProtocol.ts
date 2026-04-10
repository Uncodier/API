import { createSecretCore } from './route';
import type { CreateSecretParams } from './route';

/**
 * Creates the create_secret tool for OpenAI/assistant compatibility.
 * Use this to securely store secrets in the Vault (e.g. API keys, passwords).
 */
export function createSecretTool(site_id: string) {
  return {
    name: 'create_secret',
    description:
      'Store a secret securely in the Vault. Use this to save API keys, credentials, or sensitive data. Returns the ID of the created secret but NOT the secret value. You cannot read the secret back using this tool.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'A recognizable name for the secret (e.g. "STRIPE_API_KEY", "aws-s3-credentials").',
        },
        description: {
          type: 'string',
          description: 'A short description of what this secret is for and where it is used.',
        },
        secret: {
          type: 'string',
          description: 'The actual sensitive secret value to be securely stored.',
        },
      },
      required: ['name', 'secret', 'description'],
    },
    execute: async (args: CreateSecretParams) => {
      const result = await createSecretCore(site_id, args);
      if (!result.success && result.error) {
        const errorMsg = typeof result.error === 'string' 
          ? result.error 
          : (result.error as any).message || String(result.error);
        throw new Error(errorMsg);
      }
      return result;
    },
  };
}
