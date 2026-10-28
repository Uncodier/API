import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { createWorkspaceTools, validateWorkspaceToolArguments } from '@/lib/harness/workspace-tools';
import { WorkspaceError, WORKSPACE_ROOT, workspacePath } from '@/lib/harness/workspace';
import type { Workspace } from '@/lib/harness/types';
import { assertToolScreenAccess, ToolScreenAccessDenied, ToolScreenAccessUnavailable } from '@/app/api/agents/tools/router/screen-access';
import { resolveAssistantWorkspaceSource, type AssistantWorkspaceScope } from './workspace-source';
import { openAssistantWorkspace, AssistantWorkspaceOpenError } from './workspace-provider';

const fileReads = new Set(['read_files', 'list_files', 'search']);
const unavailable = (): never => { throw new WorkspaceError('WORKSPACE_LEASE_UNAVAILABLE', 'Workspace ownership is unavailable; no operation was executed.', false); };

/** Definitions are free of workspace I/O: only an actual tool invocation connects.
 * Use the existing schemas/implementations; no second file engine or caller sandbox IDs.
 */
export function createAssistantWorkspaceTools(scope: AssistantWorkspaceScope, assertExecution: () => Promise<void>) {
  // A descriptor is sufficient to build tool schemas; it cannot execute anything.
  const descriptor = { ref: { provider: 'vercel', id: 'unconnected', root: WORKSPACE_ROOT } } as Workspace;
  return createWorkspaceTools(descriptor).map(definition => ({
    name: definition.name,
    description: `${definition.description} Connects on demand. On a requirement-owned workspace only read_files/list_files/search inspect its saved snapshot; writes remain with the requirement owner.`,
    parameters: definition.parameters,
    async execute(raw: Record<string, unknown>) {
      let loaded: Awaited<ReturnType<typeof openAssistantWorkspace>> | undefined;
      const { thought_process: _purpose, ...provided } = raw;
      let args: Record<string, unknown>;
      try {
        validateWorkspaceToolArguments(definition, provided);
        args = provided;
        for (const path of [args.path, args.cwd,
          ...((args.files as { path: string }[] | undefined) ?? []).map(file => file.path),
          ...((args.changes as { path: string }[] | undefined) ?? []).map(change => change.path)]) {
          if (typeof path === 'string') workspacePath(path);
        }
      } catch {
        return { success: false, executed: false, error: { code: 'INVALID_WORKSPACE_ARGUMENTS',
          message: 'Use the tool schema and workspace-relative paths; secret files and parent traversal are not accessible.', effectStarted: false } };
      }
      const token = randomUUID();
      const signal = AbortSignal.timeout(150_000);
      const identity = { p_instance_id: scope.instanceId, p_site_id: scope.siteId, p_token: token };
      let claimed = false;
      let openingAttempted = false;
      let closeConfirmed = false;
      try {
        await assertExecution();
        await assertToolScreenAccess(definition.name, { siteId: scope.siteId, userId: scope.userId });
        const source = await resolveAssistantWorkspaceSource(scope);
        if (source.kind !== 'instance' && !fileReads.has(definition.name)) {
          return { success: false, executed: false, error: { code: 'WORKSPACE_OWNER_REQUIRED',
            message: 'This workspace belongs to the requirement. Use its authorized command path for edits or commands; file inspection remains available here.', effectStarted: false } };
        }
        const claim = await supabaseAdmin.rpc('claim_assistant_workspace', identity);
        if (claim.error) return unavailable();
        if (!claim.data) return { success: false, executed: false, error: { code: 'WORKSPACE_BUSY',
          message: 'Another operation owns this instance workspace. Retry after it finishes.', effectStarted: false } };
        claimed = true;
        const active = async () => {
          signal.throwIfAborted();
          await assertExecution();
          await assertToolScreenAccess(definition.name, { siteId: scope.siteId, userId: scope.userId });
          // A requirement may be linked while the direct turn is still alive.
          // Never continue writing the standalone environment after that handoff.
          if (source.kind === 'instance' && (await resolveAssistantWorkspaceSource(scope)).kind !== 'instance') {
            throw new WorkspaceError('WORKSPACE_OWNER_CHANGED', 'This instance is now requirement-owned. Reinspect its workspace before continuing.', false);
          }
          const renewed = await supabaseAdmin.rpc('renew_assistant_workspace', { ...identity, p_initialized: false });
          if (renewed.error || renewed.data !== true) return unavailable();
        };
        await active();
        openingAttempted = true;
        loaded = await openAssistantWorkspace({ scope, source, initialized: claim.data.initialized === true, assertActive: active, signal,
          assertCleanup: async () => {
            // Cancellation stops work, not cleanup by the still-current resource
            // owner. A new lease token/deleted row forbids touching its VM.
            const result = await supabaseAdmin.rpc('renew_assistant_workspace', { ...identity, p_initialized: false });
            if (result.error || result.data !== true) return unavailable();
          },
          recordResource: async name => {
            const result = await supabaseAdmin.rpc('renew_assistant_workspace', { ...identity, p_initialized: false, p_resource: name });
            if (result.error || result.data !== true) return unavailable();
          },
        });
        if (source.kind === 'instance') {
          const initialized = await supabaseAdmin.rpc('renew_assistant_workspace', { ...identity, p_initialized: true });
          if (initialized.error || initialized.data !== true) return unavailable();
        }
        const tool = createWorkspaceTools(loaded.workspace).find(tool => tool.name === definition.name)!;
        const result = await tool.execute(args, { sessionId: scope.instanceId, operationId: token, signal, assertActive: active });
        return { ...result, workspace_source: loaded.source };
      } catch (error) {
        if (error instanceof AssistantWorkspaceOpenError && error.safeToRelease) closeConfirmed = true;
        if (error instanceof WorkspaceError && ['WORKSPACE_SOURCE_UNAVAILABLE', 'WORKSPACE_SNAPSHOT_UNAVAILABLE', 'WORKSPACE_ISOLATION_REQUIRED'].includes(error.code)) closeConfirmed = true;
        if (error instanceof Error && error.name === 'RecoveryError') throw error;
        if (error instanceof ToolScreenAccessDenied || error instanceof ToolScreenAccessUnavailable) return {
          success: false, ...(loaded ? {} : { executed: false }), code: error.code, status: error.status,
          ...(error instanceof ToolScreenAccessUnavailable ? { recoverable: true } : {}),
          error: { code: error.code, message: error.message, ...(loaded ? {} : { effectStarted: false }) },
        };
        if (error instanceof WorkspaceError) return { success: false,
          ...(error.effectStarted === false ? { executed: false } : {}),
          error: { code: error.code, message: error.message, ...(error.effectStarted === false ? { effectStarted: false } : {}) } };
        return { success: false, error: { code: 'WORKSPACE_UNAVAILABLE', message: 'Workspace access could not complete. Do not infer that source files or earlier work are absent.' } };
      } finally {
        if (loaded) {
          try { await loaded.close(); closeConfirmed = true; } catch { /* TTL retains lease after an unknown stop. */ }
          loaded = undefined;
        } else closeConfirmed ||= !openingAttempted; // Unknown provider admission/stop keeps its lease until expiry.
        if (claimed && closeConfirmed) await supabaseAdmin.rpc('release_assistant_workspace', identity).then(() => undefined, () => undefined);
      }
    },
  }));
}