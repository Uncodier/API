import { supabaseAdmin } from '@/lib/database/supabase-client';

// ------------------------------------------------------------------------------------
// instance_project Tool
// ------------------------------------------------------------------------------------
export function instanceProjectTool(userId: string) {
  const execute = async (args: { action: 'list' | 'select', site_id?: string }) => {
    try {
      if (args.action === 'list') {
        const { data: sites, error } = await supabaseAdmin
          .from('sites')
          .select('id, name, url')
          .eq('user_id', userId);

        if (error) throw error;

        if (!sites || sites.length === 0) {
            return {
                success: true,
                sites: [],
                message: "You don't have any projects yet."
            };
        }

        return {
          success: true,
          sites: sites,
          message: "Here are the projects you can manage. Please select one by ID or name using action='select'."
        };
      } else if (args.action === 'select') {
         // This action is mainly for the agent to acknowledge the selection and "store" it in context
         // The agent should use the provided site_id for future calls.
         if (!args.site_id) {
             return { success: false, error: "site_id is required for select action" };
         }
         
         // Verify the user has access
         const { data: site, error } = await supabaseAdmin
            .from('sites')
            .select('name')
            .eq('id', args.site_id)
            .eq('user_id', userId)
            .single();
            
         if (error || !site) {
             return { success: false, error: "Invalid site ID or you do not have permission." };
         }

         return {
             success: true,
             selected_site_id: args.site_id,
             site_name: site.name,
             message: `Project context switched to ${site.name}. IMPORTANT: You MUST use site_id='${args.site_id}' for ALL subsequent tool calls (messages, leads, etc.) to work on this project.`
         };
      }

      return { success: false, error: "Invalid action" };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  };

  return {
    name: 'instance_project',
    description: 'Manage project context. Use action="list" to see available projects. Use action="select" with site_id to switch context. IMPORTANT: When a project is selected, you MUST use its site_id for ALL subsequent tool calls instead of the default one.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'select'],
          description: 'Action to perform'
        },
        site_id: {
          type: 'string',
          description: 'The ID of the site to select (required for select action)'
        }
      },
      required: ['action']
    },
    execute
  };
}

// ------------------------------------------------------------------------------------
// create_account Tool
// ------------------------------------------------------------------------------------
export function createAccountTool() {
  const execute = async (args: { email: string, password?: string, name?: string, phone?: string }) => {
    try {
      // Create user in Supabase Auth
      const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
        email: args.email,
        password: args.password || Math.random().toString(36).slice(-8) + "Aa1!", // Generate random password if not provided
        email_confirm: true, // Auto confirm for now
        user_metadata: {
            full_name: args.name,
            phone: args.phone
        }
      });

      if (authError) throw authError;

      return {
        success: true,
        user_id: authData.user.id,
        message: "Account created successfully. Please verify your email/phone if required."
      };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  };

  return {
    name: 'create_account',
    description: 'Create a new user account.',
    parameters: {
      type: 'object',
      properties: {
        email: { type: 'string' },
        password: { type: 'string' },
        name: { type: 'string' },
        phone: { type: 'string' }
      },
      required: ['email']
    },
    execute
  };
}

// ------------------------------------------------------------------------------------
// verify_account Tool
// ------------------------------------------------------------------------------------
export function verifyAccountTool() {
    const execute = async (args: { email: string, phone: string }) => {
        try {
            // Attempt to find user by email in public.users or public.profiles
            // This assumes a public table exists that mirrors auth.users
            let userId: string | null = null;

            // Try 'profiles' table
            const { data: user, error: userError } = await supabaseAdmin
                .from('profiles')
                .select('id')
                .eq('email', args.email)
                .maybeSingle();

            if (user) {
                userId = user.id;
            }

            if (!userId) {
                // If we can't find in public tables, we can't easily update auth user by email without ID.
                // We could try to list users but that's not efficient.
                return { success: false, error: "Could not find account with that email. Please ensure you have an account." };
            }
            
            // Update user phone in Auth
            const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(userId, {
                phone: args.phone,
                user_metadata: { phone: args.phone }
            });

            if (updateError) throw updateError;

            return { success: true, message: "Account verified and phone number linked successfully." };

        } catch (error: any) {
            return { success: false, error: error.message };
        }
    };

    return {
        name: 'verify_account',
        description: 'Verify account and link phone number when the account owner phone is not available.',
        parameters: {
            type: 'object',
            properties: {
                email: { type: 'string' },
                phone: { type: 'string' }
            },
            required: ['email', 'phone']
        },
        execute
    };
}
