import { getOutstandClient } from '@/lib/integrations/outstand/client';

export interface SocialMediaPostsParams {
  social_account_id?: string;
  limit?: number;
}

export function socialMediaPostsTool(site_id: string) {
  return {
    name: 'social_media_posts',
    description: 'Enlista las publicaciones que se han hecho en las redes sociales conectadas (historial de posts). Útil para revisar posts recientes o programados.',
    parameters: {
      type: 'object',
      properties: {
        social_account_id: {
          type: 'string',
          description: 'Opcional. ID de una cuenta social específica, para solo ver los posts de esa cuenta (se puede sacar el ID de social_media_accounts).',
        },
        limit: {
          type: 'number',
          description: 'Opcional. Cuántos posts traer. Por defecto son 10.',
        },
      },
      required: [],
    },
    execute: async (args: SocialMediaPostsParams) => {
      try {
        const client = getOutstandClient();
        
        const params: any = {};
        if (args.social_account_id) params.social_account_id = args.social_account_id;
        params.limit = args.limit || 10;

        const result = await client.listPosts(params, site_id);
        return { success: true, result };
      } catch (error: any) {
        console.error('[socialMediaPostsTool Error]', error);
        return { success: false, error: error.message };
      }
    },
  };
}
