import { supabaseAdmin } from '@/lib/database/supabase-client';

// ------------------------------------------------------------------------------------
// create_account Tool
// ------------------------------------------------------------------------------------
export function createAccountTool() {
  const execute = async (args: { email: string, password?: string, name?: string, phone?: string }) => {
    try {
      console.log(`[GearAgent Tool: create_account] Executing with args: ${JSON.stringify(args)}`);
      // Create user in Supabase Auth
      const attributes: any = {
        email: args.email,
        password: args.password || Math.random().toString(36).slice(-8) + "Aa1!", // Generate random password if not provided
        email_confirm: true, // Auto confirm for now
        user_metadata: {
            full_name: args.name,
            phone: args.phone
        }
      };

      if (args.phone) {
        attributes.phone = args.phone;
        attributes.phone_confirm = true;
      }

      const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser(attributes);

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
            console.log(`[GearAgent Tool: verify_account] Executing with args: ${JSON.stringify(args)}`);
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
