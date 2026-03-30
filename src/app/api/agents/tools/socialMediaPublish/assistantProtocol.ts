import { getOutstandClient } from '@/lib/integrations/outstand/client';

export interface SocialMediaPublishParams {
  content: string;
  accounts: string[];
  scheduledAt?: string;
}

export function socialMediaPublishTool(site_id: string) {
  return {
    name: 'social_media_publish',
    description: 'Publica un post en redes sociales o lo programa. Requiere el texto del contenido y las cuentas sociales (ej. "twitter", "linkedin"). Llama antes a social_media_accounts si no estás seguro de las cuentas.',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'Texto principal de la publicación (soporta emojis y hashtags).',
        },
        accounts: {
          type: 'array',
          items: {
            type: 'string',
          },
          description: 'Identificadores de las cuentas o redes donde publicar (ej. ["linkedin", "twitter"]). Si está vacío, fallará.',
        },
        scheduledAt: {
          type: 'string',
          description: 'Opcional. Fecha en ISO 8601 si quieres programar el post. Si no se manda, se publica ahora.',
        },
      },
      required: ['content', 'accounts'],
    },
    execute: async (args: SocialMediaPublishParams) => {
      try {
        const client = getOutstandClient();
        
        if (!args.accounts || args.accounts.length === 0) {
          throw new Error("Debes proporcionar al menos una cuenta en 'accounts'.");
        }

        const payload = {
          content: args.content,
          accounts: args.accounts,
          ...(args.scheduledAt ? { scheduledAt: args.scheduledAt } : {}),
        };

        const result = await client.createPost(payload, site_id);
        return { success: true, result };
      } catch (error: any) {
        console.error('[socialMediaPublishTool Error]', error);
        return { success: false, error: error.message };
      }
    },
  };
}
