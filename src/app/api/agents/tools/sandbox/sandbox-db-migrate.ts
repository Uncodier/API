import type { Sandbox } from '@vercel/sandbox';
import { applyPendingMigrations } from '@/lib/services/apps-platform/migration-applier';
import { migrationFailure } from '@/lib/services/apps-platform/migration-execution';
import { SandboxToolsContext, liveSandbox, deductSandboxToolCredits } from './assistantProtocol';

export function sandboxDbMigrateTool(
  sandbox: Sandbox,
  requirementId?: string,
  toolsCtx?: SandboxToolsContext
) {
  return {
    name: 'sandbox_db_migrate',
    description: 'Applies pending static SQL migrations to the bound tenant schema, atomically per file. Use after writing migrations/ or supabase/migrations/ files. On failure, inspect diagnostic and pending, correct the never-applied file in the normal implementation loop, and retry; do not delete pending files or alter applied history. Earlier successful files remain applied. Do not use for public or auth schemas. After migrating, use sandbox_db_inspect and product authorization tests to verify behavior.',
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
        
        if (result.errors.length > 0 || result.pending?.length) {
          return {
            success: false,
            error: result.errors.length > 0
              ? `Failed to apply some migrations:\n${result.errors.join('\n')}`
              : `Unapplied migrations remain: ${result.pending!.join(', ')}.`,
            applied: result.applied,
            ...(result.failureKind ? { failureKind: result.failureKind } : {}),
            ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}),
            ...(result.pending ? { pending: result.pending } : {}),
          };
        }
        
        if (result.applied.length === 0) {
          return {
            success: true,
            message: 'No pending migrations found. All migrations are already applied.',
            applied: [],
            receipt: {
              kind: 'database_migration',
              applied: [],
              pending: 0,
            },
          };
        }
        
        return {
          success: true,
          message: `Successfully applied ${result.applied.length} migrations.`,
          applied: result.applied,
          receipt: {
            kind: 'database_migration',
            applied: result.applied,
            pending: 0,
          },
        };
      } catch (err: unknown) {
        return {
          success: false,
          ...migrationFailure(err),
        };
      }
    }
  };
}
