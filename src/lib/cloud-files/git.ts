import { createHash } from 'node:crypto';
import type { CloudFileStore } from './store';
import type { CloudRevision, CloudScope } from './types';
import { CloudFileStoreError } from './types';
import {
  readAuthorizedCloudRevision, validateCloudRevision,
  type CloudRevisionAccess,
} from './archive';

export type CloudGitErrorCode = 'unconfigured' | 'private_repository_required' | 'conflict'
  | 'repository_uninitialized' | 'configuration_mismatch' | 'unavailable' | 'inactive' | 'invalid_revision';
export class CloudGitError extends Error {
  constructor(public readonly code: CloudGitErrorCode) {
    super(`Cloud Git publication: ${code}`);
    this.name = 'CloudGitError';
  }
}
export interface CloudGitDependencies extends Omit<CloudRevisionAccess, 'store'> {
  store?: Pick<CloudFileStore, 'read' | 'setGitResult' | 'bindGitTarget'>;
  env?: Record<string, string | undefined>;
  fetch?: typeof globalThis.fetch;
}
const hash = (input: string | Buffer) => createHash('sha256').update(input).digest('hex');
const isSha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

/** No user/file names in refs. One immutable branch per tenant/instance/file/version. */
export function cloudRevisionBranch(scope: CloudScope, revision: CloudRevision): string {
  return `cloud-files/${hash(JSON.stringify([scope.siteId, scope.instanceId, revision.file_id]))}/v${revision.version}`;
}

/**
 * Publishes to an explicitly acknowledged private, non-deploy repository only.
 * Each revision is a complete one-document tree (not an executable workspace).
 * A known previous commit is retained as parent; otherwise the revision is orphaned.
 * Repository privacy is checked before initial binding; repository/ref/path are
 * durably bound before provider writes, and cannot be
 * changed by later environment configuration. Cross-repository parents fail closed.
 * No branch update/force push, deployment API, token fallback, or automatic POST retry.
 * NO_DEPLOY is an operator acknowledgement: GitHub privacy does not prove that a
 * repository has no external deploy hooks; those must be disabled by its owner.
 */
export async function publishCloudRevision(
  scope: CloudScope, requested: CloudRevision, deps: CloudGitDependencies = {},
): Promise<CloudRevision> {
  const env = deps.env ?? process.env;
  const repository = env.CLOUD_FILES_GITHUB_REPOSITORY;
  const token = env.CLOUD_FILES_GITHUB_TOKEN;
  if (!repository || !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(repository)
    || repository.split('/').some(part => part === '.' || part === '..')
    || !token || /\s/.test(token) || env.CLOUD_FILES_GITHUB_NO_DEPLOY !== 'true') {
    throw new CloudGitError('unconfigured');
  }
  let store: NonNullable<CloudGitDependencies['store']>;
  try { store = deps.store ?? (await import('./store')).createCloudFileStore(); }
  catch { throw new CloudGitError('unavailable'); }
  const access = { ...deps, store };
  let canonical: CloudRevision;
  try { canonical = await readAuthorizedCloudRevision(scope, requested, access); }
  catch { throw new CloudGitError('invalid_revision'); }
  const active = async () => {
    try {
      const current = await readAuthorizedCloudRevision(scope, canonical, access);
      if (canonical.git_repository && (current.git_repository !== canonical.git_repository
        || current.git_ref !== canonical.git_ref || current.git_path !== canonical.git_path)) {
        throw new CloudGitError('conflict');
      }
    }
    catch { throw new CloudGitError('inactive'); }
  };
  const bytes = validateCloudRevision(canonical);
  const branch = cloudRevisionBranch(scope, canonical);
  const target = { repository, ref: `refs/heads/${branch}`, path: canonical.name };
  const targetMatches = (revision: CloudRevision) => revision.git_repository === target.repository
    && revision.git_ref === target.ref && revision.git_path === target.path;
  const payloadHash = hash(JSON.stringify([branch, canonical.name, canonical.mime, canonical.sha256, canonical.bytes]));
  const message = `Private cloud document revision [skip ci]\n\ncloud-payload-sha256: ${payloadHash}`;
  const base = `https://api.github.com/repos/${repository}`;
  const request = async (path: string, method = 'GET', body?: object): Promise<{ status: number; data: any }> => {
    await active();
    const controller = new AbortController();
    const abort = () => controller.abort();
    deps.signal?.addEventListener('abort', abort, { once: true });
    if (deps.signal?.aborted) controller.abort();
    const timer = setTimeout(abort, 15_000);
    try {
      const response = await (deps.fetch ?? globalThis.fetch)(base + path, {
        method, redirect: 'error', cache: 'no-store', signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      // Fixed errors only: provider bodies, URLs, headers and credentials are never surfaced.
      if (!response.ok) {
        await response.body?.cancel();
        return { status: response.status, data: null };
      }
      // Bound all upstream JSON, including base64 blobs and unexpected repo data.
      const reader = response.body?.getReader();
      if (!reader) throw new CloudGitError('unavailable');
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 1024 * 1024) { await reader.cancel(); throw new CloudGitError('unavailable'); }
          chunks.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      return { status: response.status, data };
    } catch { throw new CloudGitError('unavailable'); }
    finally {
      clearTimeout(timer);
      deps.signal?.removeEventListener('abort', abort);
    }
  };
  const required = async (path: string, method = 'GET', body?: object) => {
    const result = await request(path, method, body);
    if (result.status < 200 || result.status >= 300 || !result.data) throw new CloudGitError('unavailable');
    return result.data;
  };
  const privateRepo = async () => {
    const repo = await required('');
    if (repo.private !== true || repo.visibility !== 'private' || typeof repo.full_name !== 'string'
      || repo.full_name.toLowerCase() !== repository.toLowerCase()) {
      throw new CloudGitError('private_repository_required');
    }
  };
  const refPath = `/git/ref/heads/${branch}`;
  const verifyExisting = async (): Promise<string | null> => {
    const ref = await request(refPath);
    if (ref.status === 404) return null;
    if (ref.status !== 200) throw new CloudGitError('unavailable');
    const sha = ref.data?.object?.sha;
    if (ref.data?.ref !== `refs/heads/${branch}` || ref.data?.object?.type !== 'commit' || !isSha(sha)) {
      throw new CloudGitError('conflict');
    }
    const commit = await required(`/git/commits/${sha}`);
    if (commit.sha !== sha || commit.message !== message || !isSha(commit.tree?.sha)) throw new CloudGitError('conflict');
    const tree = await required(`/git/trees/${commit.tree.sha}?recursive=1`);
    if (tree.truncated !== false || !Array.isArray(tree.tree)) throw new CloudGitError('conflict');
    const files = tree.tree.filter((entry: any) => entry.type !== 'tree');
    if (files.length !== 1 || files[0].path !== canonical.name || files[0].type !== 'blob'
      || files[0].mode !== '100644' || !isSha(files[0].sha)) throw new CloudGitError('conflict');
    const blob = await required(`/git/blobs/${files[0].sha}`);
    if (blob.encoding !== 'base64' || typeof blob.content !== 'string'
      || blob.content.length > 400_000 || blob.sha !== files[0].sha || blob.size !== bytes.length) {
      throw new CloudGitError('conflict');
    }
    const remote = Buffer.from(blob.content, 'base64');
    const gitSha = createHash('sha1').update(`blob ${remote.length}\0`).update(remote).digest('hex');
    if (!remote.equals(bytes) || hash(remote) !== canonical.sha256 || gitSha !== blob.sha) throw new CloudGitError('conflict');
    return sha;
  };
  const finish = async (sha: string) => {
    await privateRepo();
    await active();
    try {
      const result = await store.setGitResult(scope, canonical.file_id, canonical.version, { status: 'committed', commitSha: sha });
      if (result.git_status !== 'committed' || result.git_commit_sha !== sha || !targetMatches(result)) throw new CloudGitError('unavailable');
      return result;
    }
    catch { throw new CloudGitError('unavailable'); }
  };
  try {
    if ((canonical.git_repository || canonical.git_ref || canonical.git_path || canonical.git_status === 'committed')
      && !targetMatches(canonical)) throw new CloudGitError('configuration_mismatch');
    const parents: string[] = [];
    if (canonical.version > 1) {
      await active();
      const previous = await store.read(scope, canonical.file_id, canonical.version - 1);
      if (previous?.git_status === 'committed') {
        if (previous.git_repository !== repository) throw new CloudGitError('configuration_mismatch');
        if (!isSha(previous.git_commit_sha)
          || previous.git_ref !== `refs/heads/${cloudRevisionBranch(scope, previous)}`
          || previous.git_path !== previous.name) throw new CloudGitError('conflict');
        parents.push(previous.git_commit_sha);
      }
    }
    // A typo, inaccessible repo, or non-private initial target must not become
    // an immutable binding. This request is read-only and contains no document.
    await privateRepo();
    // Git Data cannot create refs in an empty repo. Never initialize a default
    // branch implicitly; leave this revision unbound and pending for the operator.
    const history = await request('/commits?per_page=1');
    if (history.status === 409 || (history.status === 200 && Array.isArray(history.data) && history.data.length === 0)) {
      throw new CloudGitError('repository_uninitialized');
    }
    if (history.status !== 200 || !Array.isArray(history.data) || history.data.length !== 1 || !isSha(history.data[0]?.sha)) {
      throw new CloudGitError('unavailable');
    }
    await active();
    try {
      const bound = await store.bindGitTarget(scope, canonical.file_id, canonical.version, target);
      if (!targetMatches(bound)) throw new CloudGitError('configuration_mismatch');
      canonical = await readAuthorizedCloudRevision(scope, requested, access);
      if (!targetMatches(canonical)) throw new CloudGitError('configuration_mismatch');
    } catch (error) {
      if (error instanceof CloudFileStoreError && error.code === 'operation_mismatch') throw new CloudGitError('configuration_mismatch');
      if (error instanceof CloudGitError) throw error;
      throw new CloudGitError('unavailable');
    }
    await privateRepo();
    const existing = await verifyExisting();
    if (existing) {
      if (canonical.git_status === 'committed' && canonical.git_commit_sha !== existing) throw new CloudGitError('conflict');
      return await finish(existing);
    }
    // A missing remote ref must not silently replace an already recorded commit.
    if (canonical.git_status === 'committed') throw new CloudGitError('conflict');
    await privateRepo();
    const blob = await required('/git/blobs', 'POST', { content: bytes.toString('base64'), encoding: 'base64' });
    if (!isSha(blob.sha)) throw new CloudGitError('unavailable');
    const tree = await required('/git/trees', 'POST', {
      tree: [{ path: canonical.name, mode: '100644', type: 'blob', sha: blob.sha }],
    });
    if (!isSha(tree.sha)) throw new CloudGitError('unavailable');
    const identity = { name: 'Cloud Files', email: 'cloud-files@example.invalid', date: '2000-01-01T00:00:00Z' };
    const commit = await required('/git/commits', 'POST', { message, tree: tree.sha, parents, author: identity, committer: identity });
    if (!isSha(commit.sha)) throw new CloudGitError('unavailable');
    await privateRepo();
    try {
      // If this times out, recover with GET. Never retry this POST in the invocation.
      const ref = await request('/git/refs', 'POST', { ref: `refs/heads/${branch}`, sha: commit.sha });
      if (![201, 409, 422].includes(ref.status)) throw new CloudGitError('unavailable');
    } catch (error) {
      if (!(error instanceof CloudGitError) || error.code !== 'unavailable') throw error;
    }
    const verified = await verifyExisting();
    if (!verified) throw new CloudGitError('unavailable');
    return await finish(verified);
  } catch (error) {
    const safe = error instanceof CloudGitError ? error : new CloudGitError('unavailable');
    // Ambiguous transport failures retain the durable pending intent for recovery.
    // Configuration mismatch leaves the original queue intent untouched.
    // Initial privacy denial also remains unbound and retryable after correction.
    if (safe.code === 'conflict' || (safe.code === 'private_repository_required' && targetMatches(canonical))) {
      try {
        await active();
        await store.setGitResult(scope, canonical.file_id, canonical.version, {
          status: safe.code === 'conflict' ? 'conflict' : 'failed',
        });
      } catch { /* Never replace the fixed public error with persistence details. */ }
    }
    throw safe;
  }
}