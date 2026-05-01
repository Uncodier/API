import { getOutstandClient } from '@/lib/integrations/outstand/client';

export interface SocialMediaAccountsParams {
  // Sin parámetros requeridos
}

export function socialMediaAccountsTool(site_id: string) {
  return {
    name: 'social_media_accounts',
    description: 'Lista todas las cuentas de redes sociales (ej. Twitter, LinkedIn, Facebook) que tienes conectadas. Llama a esto para saber en qué cuentas puedes publicar o leer posts.',
    parameters: {
      type: 'object',
      properties: {
        _dummy: { type: 'string', description: 'Not used' }
      },
      required: [],
    },
    execute: async (args: SocialMediaAccountsParams) => {
      try {
        const client = getOutstandClient();
        const accounts = await client.listAccounts(site_id);
        return { success: true, data: accounts };
      } catch (error: any) {
        console.error('[socialMediaAccountsTool Error]', error);
        return { success: false, error: error.message };
      }
    },
  };
}
