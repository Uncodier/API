import { Sandbox } from '@vercel/sandbox';
import { applyPendingMigrations } from '@/lib/services/apps-platform/migration-applier';
import { SandboxToolsContext, liveSandbox, deductSandboxToolCredits } from './assistantProtocol';

export function sandboxDbMigrateTool(
  sandbox: Sandbox,
  requirementId?: string,
  toolsCtx?: SandboxToolsContext
) {
  return {
    name: 'sandbox_db_migrate',
    description: 'Applies pending SQL migrations to the tenant database schema. Use this tool after writing new migration files (e.g. in migrations/ or supabase/migrations/) to execute them against the database. Do not use this for public or auth schemas. After migrating, use sandbox_db_inspect to verify tables instead of writing custom test scripts.',
    parameters: {
      type: 'object',
      properties: {
        _dummy: { type: 'string', description: 'Not used' }
      },
    },
    execute: async () => {
      const creditCheck = await deductSandboxToolCredits(toolsCtx, 'sandbox_db_migrate', {});
      if (!creditCheck.success) {
        return { success: false, error: creditCheck.error };
      }

      if (!requirementId) {
        return { success: false, error: 'requirement_id is missing in sandbox context; cannot apply migrations.' };
      }
      
      try {
        const s0 = liveSandbox(sandbox, toolsCtx);
        const result = await applyPendingMigrations(s0, requirementId);
        
        if (result.errors.length > 0) {
          return {
            success: false,
            error: `Failed to apply some migrations:\n${result.errors.join('\n')}`,
            applied: result.applied
          };
        }
        
        if (result.applied.length === 0) {
          return {
            success: true,
            message: 'No pending migrations found. All migrations are already applied.'
          };
        }
        
        return {
          success: true,
          message: `Successfully applied ${result.applied.length} migrations.`,
          applied: result.applied
        };
      } catch (err: any) {
        return {
          success: false,
          error: `Error applying migrations: ${err?.message || String(err)}`
        };
      }
    }
  };
}
