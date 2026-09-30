import { getOutstandClient } from '@/lib/integrations/outstand/client';
import { listConnectedAccounts, SocialAccountResolutionError } from '@/lib/integrations/outstand/accounts';

export interface SocialMediaAccountsParams {
  _dummy?: string;
}

export function socialMediaAccountsTool(site_id: string) {
  return {
    name: 'social_media_accounts',
    description: 'List social accounts connected to this site, including their account ID, network, username, and active flag. Use an exact active account ID when publishing; inactive accounts must be reconnected first.',
    parameters: {
      type: 'object',
      properties: {
        _dummy: { type: 'string', description: 'Not used' }
      },
      required: [],
    },
    execute: async (_args: SocialMediaAccountsParams) => {
      try {
        const client = getOutstandClient();
        const accounts = await listConnectedAccounts(client, site_id);
        return { success: true, data: accounts };
      } catch (error: unknown) {
        const errorCode = error instanceof SocialAccountResolutionError ? error.code : 'ACCOUNT_PROVIDER_ERROR';
        console.error('[socialMediaAccountsTool Error]', errorCode);
        return {
          success: false,
          error: error instanceof SocialAccountResolutionError
            ? error.message
            : 'Unable to load connected social accounts. Try again.',
          error_code: errorCode,
        };
      }
    },
  };
}
