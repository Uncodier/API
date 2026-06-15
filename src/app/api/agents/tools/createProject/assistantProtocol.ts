import { supabaseAdmin } from '@/lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';

export interface CreateProjectParams {
  name: string;
  domain?: string;
}

export function createProjectTool(userId?: string | null) {
  return {
    name: 'create_project',
    description: 'Create a new project (site) for the user.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'The name of the new project/site.'
        },
        domain: {
          type: 'string',
          description: 'The domain for the new project/site (optional).'
        }
      },
      required: ['name']
    },
    execute: async (args: CreateProjectParams) => {
      try {
        if (!userId) {
          return {
            success: false,
            error: 'You are not logged in. Cannot create a project.',
          };
        }

        const siteId = uuidv4();
        
        const { data: site, error } = await supabaseAdmin
          .from('sites')
          .insert([{
            id: siteId,
            name: args.name,
            domain: args.domain,
            user_id: userId,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          }])
          .select()
          .single();

        if (error) {
          console.error('[CreateProjectTool] Error creating site:', error);
          return {
            success: false,
            error: `Failed to create project: ${error.message}`
          };
        }

        // Trigger initializeProject / site setup automatically for the new site
        try {
          const baseUrl = process.env.API_URL || 'http://localhost:3000';
          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
          };
          if (process.env.SERVICE_API_KEY) {
            headers['x-api-key'] = process.env.SERVICE_API_KEY;
          }
          await fetch(`${baseUrl}/api/site/setup`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ 
              site_id: siteId,
              user_id: userId,
              setup_type: 'basic'
            })
          });
          console.log(`[CreateProjectTool] Triggered site setup (initialize project) for ${siteId}`);
        } catch (setupErr) {
          console.error(`[CreateProjectTool] Failed to trigger site setup:`, setupErr);
          // Don't fail the tool execution if setup triggering fails
        }

        return {
          success: true,
          message: `Project '${args.name}' created successfully with ID ${siteId}.`,
          project: site
        };
      } catch (err: any) {
        console.error('[CreateProjectTool] Exception:', err);
        return {
          success: false,
          error: `Error: ${err.message}`,
        };
      }
    }
  };
}
