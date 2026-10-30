import { supabaseAdmin } from '@/lib/database/supabase-client';
import {
  CloudFileStoreError,
  type CloudFileStoreErrorCode, type CloudScope, type CloudRevision,
  type CloudListInput, type CloudListResult, type CloudWriteInput,
  type CloudWriteResult, type CloudGitResult, type CloudGitTarget,
} from './types';

export { CloudFileStoreError } from './types';
export const MAX_CLOUD_FILE_BYTES = 256 * 1024;

/** Minimal injectable interface: all authorization and mutations happen in one RPC. */
export interface CloudFileRpcClient {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{
    data: unknown;
    error: { code?: string } | null;
  }>;
}
const errorCodes: Record<string, CloudFileStoreErrorCode> = {
  CF001: 'invalid_input', CF002: 'forbidden', CF003: 'not_found',
  CF004: 'operation_mismatch', CF005: 'patch_conflict', CF006: 'quota_exceeded',
  '42501': 'forbidden', '22P02': 'invalid_input', '22023': 'invalid_input',
  '22003': 'invalid_input', '22021': 'invalid_input',
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createCloudFileStore(client: CloudFileRpcClient = supabaseAdmin) {
  async function call<T>(scope: CloudScope, operation: string, input: object): Promise<T> {
    if (!scope || ![scope.siteId, scope.userId, scope.instanceId].every(v => typeof v === 'string' && uuid.test(v))
      || (scope.requirementId !== undefined && !uuid.test(scope.requirementId))) {
      throw new CloudFileStoreError('invalid_input');
    }
    try {
      const { data, error } = await client.rpc('cloud_file_store', {
        p_site_id: scope.siteId, p_user_id: scope.userId, p_instance_id: scope.instanceId,
        p_requirement_id: scope.requirementId ?? null, p_operation: operation, p_input: input,
      });
      if (error) throw new CloudFileStoreError(errorCodes[error.code ?? ''] ?? 'unavailable');
      return data as T;
    } catch (error) {
      if (error instanceof CloudFileStoreError) throw error;
      // Never propagate raw database/provider errors or content-bearing diagnostics.
      throw new CloudFileStoreError('unavailable');
    }
  }
  return {
    /** Missing receipt is unknown, never proof a crashed operation is retry-safe. */
    readOperation: (scope: CloudScope, operationId: string) =>
      call<CloudWriteResult | null>(scope, 'operation', { operation_id: operationId }),
    read: (scope: CloudScope, fileId: string, version?: number) =>
      call<CloudRevision | null>(scope, 'read', { file_id: fileId, ...(version === undefined ? {} : { version }) }),
    list: (scope: CloudScope, input: CloudListInput = {}) => call<CloudListResult>(scope, 'list', input),
    /** Recovery enumerates all uncommitted versions, including superseded ones. */
    listPendingGit: (scope: CloudScope, input: Pick<CloudListInput, 'offset' | 'limit'> = {}) =>
      call<CloudListResult>(scope, 'git_pending', input),
    write: (scope: CloudScope, input: CloudWriteInput) => call<CloudWriteResult>(scope, 'write', input),
    bindGitTarget: (scope: CloudScope, fileId: string, version: number, target: CloudGitTarget) =>
      call<CloudRevision>(scope, 'git_bind', { file_id: fileId, version, ...target }),
    setGitResult: (scope: CloudScope, fileId: string, version: number, input: CloudGitResult) =>
      call<CloudRevision>(scope, 'git_result', { file_id: fileId, version, ...input }),
  };
}

export type CloudFileStore = ReturnType<typeof createCloudFileStore>;