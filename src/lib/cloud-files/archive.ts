import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import type { CloudFileStore } from './store';
import type { CloudRevision, CloudScope } from './types';

export interface CloudRevisionAccess {
  store?: Pick<CloudFileStore, 'read'>;
  /** Trusted execution/ownership guard; never supplied by model arguments. */
  assertActive?: () => Promise<void>;
  signal?: AbortSignal;
}

export class CloudRevisionAccessError extends Error {
  constructor(public readonly code: 'invalid_revision' | 'unavailable' | 'inactive') {
    super(`Cloud revision: ${code}`);
    this.name = 'CloudRevisionAccessError';
  }
}

/** Shared ZIP/Git path policy: no traversal, platform aliases, or Git control paths. */
export function validateCloudRevision(revision: CloudRevision): Buffer {
  if (!revision || typeof revision.content !== 'string' || typeof revision.name !== 'string'
    || !revision.name || Buffer.byteLength(revision.name) > 512
    || /[\\:\x00-\x1f\x7f]/.test(revision.name)
    || revision.name.split('/').some(part => !part || part === '.' || part === '..'
      || ['.git', '.github'].includes(part.toLowerCase()) || /[. ]$/.test(part)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
    || !Number.isSafeInteger(revision.version) || revision.version < 1) {
    throw new CloudRevisionAccessError('invalid_revision');
  }
  const bytes = Buffer.from(revision.content, 'utf8');
  if (bytes.length > 256 * 1024 || bytes.length !== revision.bytes
    || bytes.toString('utf8') !== revision.content
    || createHash('sha256').update(bytes).digest('hex') !== revision.sha256) {
    throw new CloudRevisionAccessError('invalid_revision');
  }
  return bytes;
}

export async function cloudRevisionStore(deps: CloudRevisionAccess): Promise<Pick<CloudFileStore, 'read'>> {
  try { return deps.store ?? (await import('./store')).createCloudFileStore(); }
  catch { throw new CloudRevisionAccessError('unavailable'); }
}

/** Read only through the scoped durable store, never export caller-provided bytes. */
export async function readAuthorizedCloudRevision(
  scope: CloudScope, requested: CloudRevision, deps: CloudRevisionAccess,
): Promise<CloudRevision> {
  try {
    if (deps.signal?.aborted) throw new CloudRevisionAccessError('inactive');
    if (deps.assertActive) {
      try { await deps.assertActive(); } catch { throw new CloudRevisionAccessError('inactive'); }
    }
    if (deps.signal?.aborted) throw new CloudRevisionAccessError('inactive');
    const store = await cloudRevisionStore(deps);
    const revision = await store.read(scope, requested.file_id, requested.version);
    if (!revision || revision.file_id !== requested.file_id || revision.version !== requested.version
      || revision.instance_id !== scope.instanceId
      || (scope.requirementId !== undefined && revision.requirement_id !== scope.requirementId)
      || revision.sha256 !== requested.sha256 || revision.name !== requested.name
      || revision.mime !== requested.mime || revision.content !== requested.content
      || revision.bytes !== requested.bytes || revision.requirement_id !== requested.requirement_id) {
      throw new CloudRevisionAccessError('invalid_revision');
    }
    validateCloudRevision(revision);
    return revision;
  } catch (error) {
    if (error instanceof CloudRevisionAccessError) throw error;
    throw new CloudRevisionAccessError('unavailable');
  }
}

/** Private source export. No sandbox, repository, public upload, or metadata entry. */
export async function archiveCloudRevision(
  scope: CloudScope, revision: CloudRevision, deps: CloudRevisionAccess = {},
): Promise<Buffer> {
  const store = await cloudRevisionStore(deps);
  const canonical = await readAuthorizedCloudRevision(scope, revision, { ...deps, store });
  const zip = new JSZip();
  zip.file(canonical.name, validateCloudRevision(canonical), {
    date: new Date('2000-01-01T00:00:00Z'), createFolders: false,
    unixPermissions: 0o100644,
  });
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', platform: 'UNIX' });
  await readAuthorizedCloudRevision(scope, canonical, { ...deps, store });
  return buffer;
}