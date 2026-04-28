import { SandboxToolsContext, deductSandboxToolCredits } from './assistantProtocol';
import { getAppsAdminClient } from '@/lib/database/apps-supabase';

function schemaForRequirement(requirementId: string): string {
  return `app_${requirementId.replace(/-/g, '').slice(0, 24)}`;
}

export function sandboxDbInspectTool(
  requirementId?: string,
  toolsCtx?: SandboxToolsContext
) {
  return {
    name: 'sandbox_db_inspect',
    description: 'Verifies if a table exists in the tenant database schema and returns its structure or a sample row. Use this INSTEAD of writing custom Node.js scripts to test the database connection.',
    parameters: {
      type: 'object',
      properties: {
        table_name: {
          type: 'string',
          description: 'The name of the table to inspect (e.g., "profiles", "spaces").'
        }
      },
      required: ['table_name']
    },
    execute: async (args: { table_name: string }) => {
      const creditCheck = await deductSandboxToolCredits(toolsCtx, 'sandbox_db_inspect', args);
      if (!creditCheck.success) {
        return { success: false, error: creditCheck.error };
      }

      if (!requirementId) {
        return { success: false, error: 'requirement_id is missing in sandbox context; cannot inspect database.' };
      }

      try {
        const client = getAppsAdminClient();
        const schema = schemaForRequirement(requirementId);

        // We use the Supabase client to query the specific schema and table.
        // The admin client (service_role) bypasses RLS, so we can just select 1 row to verify it exists.
        const { data, error } = await client
          .schema(schema as any)
          .from(args.table_name)
          .select('*')
          .limit(1);

        if (error) {
          return {
            success: false,
            error: `Failed to query table '${args.table_name}': ${error.message}. The table might not exist or the migration failed.`
          };
        }

        return {
          success: true,
          message: `Table '${args.table_name}' exists and is accessible.`,
          sample_data: data
        };
      } catch (err: any) {
        return {
          success: false,
          error: `Error inspecting table: ${err?.message || String(err)}`
        };
      }
    }
  };
}
