/** Scope is supplied by the authenticated host, never by model tool arguments. */
export interface CloudScope {
  siteId: string;
  userId: string;
  instanceId: string;
  requirementId?: string;
}

export type CloudGitStatus = 'pending' | 'committed' | 'failed' | 'conflict';
export interface CloudRevision {
  file_id: string;
  version: number;
  name: string;
  mime: string;
  content: string;
  sha256: string;
  bytes: number;
  requirement_id: string | null;
  instance_id: string;
  git_status: CloudGitStatus;
  git_commit_sha?: string | null;
  git_repository?: string | null;
  git_ref?: string | null;
  git_path?: string | null;
}
export interface CloudWriteInput {
  /** Host-generated UUID. Replays must use precisely the same input. */
  operation_id: string;
  action: 'create' | 'replace' | 'patch';
  file_id?: string;
  expected_version?: number;
  name?: string;
  mime?: string;
  content?: string;
  /** Each old_text must match exactly once; changes apply in order, atomically. */
  changes?: Array<{ old_text: string; new_text: string }>;
}
export type CloudWriteResult = CloudRevision & {
  state: 'created' | 'updated' | 'unchanged' | 'conflict';
};
export interface CloudListInput {
  requirement_id?: string;
  query?: string;
  offset?: number;
  limit?: number;
}
export interface CloudListResult {
  files: CloudRevision[];
  next_offset: number | null;
}
export interface CloudGitResult {
  status: CloudGitStatus;
  commitSha?: string | null;
}
export interface CloudGitTarget {
  repository: string;
  /** Full immutable ref, including refs/heads/. */
  ref: string;
  path: string;
}
export type CloudFileStoreErrorCode =
  | 'invalid_input' | 'forbidden' | 'not_found' | 'operation_mismatch'
  | 'patch_conflict' | 'quota_exceeded' | 'unavailable';

export class CloudFileStoreError extends Error {
  constructor(public readonly code: CloudFileStoreErrorCode) {
    super(`Cloud file store: ${code}`);
    this.name = 'CloudFileStoreError';
  }
}