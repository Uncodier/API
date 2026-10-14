import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { HostConfiguration, HostStateStore, SessionStore } from './types';
import type { SessionStoreClient } from './store';
import { validateLease } from './store';

export const HOST_STATE_MAX_BYTES = 256 * 1024;
export const HOST_STATE_MAX_REDACTION_VALUES = 1000;
const DOMAIN = 'portable-harness/host-state/aes-256-gcm/v1';
interface EncryptedRow { version: number; ciphertext: string }

export class HostStateStoreError extends Error {
  constructor(public readonly code: 'invalid' | 'conflict' | 'storage' | 'encryption') {
    super(code === 'encryption' ? 'Harness host state encryption unavailable or authentication failed' : `Harness host state ${code}`);
    this.name = 'HostStateStoreError';
  }
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const validVersion = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) < Number.MAX_SAFE_INTEGER;

function validateConfiguration(value: unknown): asserts value is HostConfiguration {
  if (!record(value) || !record(value.layers) || !Array.isArray(value.redactionValues) ||
      value.redactionValues.length > HOST_STATE_MAX_REDACTION_VALUES || value.redactionValues.some(item => typeof item !== 'string') ||
      Object.keys(value).some(key => key !== 'layers' && key !== 'redactionValues')) throw new HostStateStoreError('invalid');
  for (const layer of Object.values(value.layers)) {
    if (!record(layer) || !record(layer.values) || Object.values(layer.values).some(item => typeof item !== 'string') ||
        Object.keys(layer).some(key => !['values', 'expiresAt', 'refresh'].includes(key)) ||
        (layer.expiresAt !== undefined && (typeof layer.expiresAt !== 'string' || !Number.isFinite(Date.parse(layer.expiresAt)))) ||
        (layer.refresh !== undefined && (!record(layer.refresh) || layer.refresh.kind !== 'tenant' ||
          typeof layer.refresh.requirementId !== 'string' || !layer.refresh.requirementId ||
          Object.keys(layer.refresh).some(key => !['kind', 'requirementId'].includes(key))))) throw new HostStateStoreError('invalid');
  }
}

function keyMaterial(encryptionKey?: string): Buffer {
  const value = encryptionKey ?? process.env.ENCRYPTION_KEY;
  if (typeof value !== 'string' || !value.trim()) throw new HostStateStoreError('encryption');
  return createHash('sha256').update(DOMAIN).update('\0key\0').update(value, 'utf8').digest();
}

function aad(id: string, siteId: string, version: number): Buffer {
  return Buffer.from(JSON.stringify([DOMAIN, id, siteId, version]), 'utf8');
}

function encrypt(configuration: HostConfiguration, id: string, siteId: string, version: number, encryptionKey?: string): string {
  validateConfiguration(configuration);
  let plaintext: string;
  try { plaintext = JSON.stringify(configuration); } catch { throw new HostStateStoreError('invalid'); }
  if (Buffer.byteLength(plaintext, 'utf8') > HOST_STATE_MAX_BYTES) throw new HostStateStoreError('invalid');
  const key = keyMaterial(encryptionKey);
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad(id, siteId, version));
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const ciphertext = ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join('.');
    // The bound covers the entire persisted representation, including base64 expansion.
    if (Buffer.byteLength(ciphertext, 'utf8') > HOST_STATE_MAX_BYTES) throw new HostStateStoreError('invalid');
    return ciphertext;
  } finally { key.fill(0); }
}

function decrypt(row: EncryptedRow, id: string, siteId: string, encryptionKey?: string): HostConfiguration {
  if (!row || !validVersion(row.version) || row.version < 1 || typeof row.ciphertext !== 'string' ||
      Buffer.byteLength(row.ciphertext, 'utf8') > HOST_STATE_MAX_BYTES) throw new HostStateStoreError('encryption');
  const key = keyMaterial(encryptionKey);
  try {
    const parts = row.ciphertext.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1' || parts.slice(1).some(part => !/^[A-Za-z0-9+/]+={0,2}$/.test(part))) throw new Error();
    const [iv, tag, body] = parts.slice(1).map(part => Buffer.from(part, 'base64'));
    if (iv.length !== 12 || tag.length !== 16) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(aad(id, siteId, row.version));
    decipher.setAuthTag(tag);
    const configuration: unknown = JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8'));
    validateConfiguration(configuration);
    return configuration;
  } catch { throw new HostStateStoreError('encryption'); }
  finally { key.fill(0); }
}

function scope(id: string, siteId: string, owner: string): void {
  validateLease(owner);
  if (typeof id !== 'string' || !id || typeof siteId !== 'string' || !siteId) throw new HostStateStoreError('invalid');
}

/** Host-only repository. The transport receives ciphertext, never configuration or retained secrets. */
export function createHostStateStore(client?: Pick<SessionStoreClient, 'rpc'>, encryptionKey?: string): HostStateStore {
  let pending: Promise<Pick<SessionStoreClient, 'rpc'>> | undefined;
  const rpc = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    try {
      const db: Pick<SessionStoreClient, 'rpc'> = client ?? await (pending ??= import('../database/supabase-client').then(module => module.supabaseAdmin));
      const { data, error } = await db.rpc(name, args);
      if (error) {
        const code = (error as { code?: string }).code;
        throw new HostStateStoreError(code === 'P0002' ? 'conflict' : code === '22023' ? 'invalid' : 'storage');
      }
      return data;
    } catch (error) {
      if (error instanceof HostStateStoreError) throw error;
      // Client exceptions may contain SQL arguments. Do not attach a cause.
      throw new HostStateStoreError('storage');
    }
  };
  return {
    async load(id, siteId, owner) {
      scope(id, siteId, owner);
      const row = await rpc('load_harness_host_state', { p_id: id, p_site_id: siteId, p_owner: owner }) as EncryptedRow | null;
      if (!row) return { version: 0, configuration: { layers: {}, redactionValues: [] } };
      return { version: row.version, configuration: decrypt(row, id, siteId, encryptionKey) };
    },
    async save(id, siteId, owner, expectedVersion, configuration) {
      scope(id, siteId, owner);
      if (!validVersion(expectedVersion) || expectedVersion + 1 >= Number.MAX_SAFE_INTEGER) throw new HostStateStoreError('invalid');
      const ciphertext = encrypt(configuration, id, siteId, expectedVersion + 1, encryptionKey);
      const version = await rpc('save_harness_host_state', { p_id: id, p_site_id: siteId, p_owner: owner,
        p_expected_version: expectedVersion, p_ciphertext: ciphertext });
      if (version !== expectedVersion + 1) throw new HostStateStoreError('conflict');
      return version as number;
    },
  };
}

// Shared by composed in-memory repositories. Reconstructing a host adapter does not erase rotations.
// Even the offline representation retains only ciphertext, not a configuration object.
const memoryRows = new WeakMap<SessionStore, Map<string, EncryptedRow>>();
export function createMemoryHostStateStore(sessionStore: SessionStore, encryptionKey?: string): HostStateStore {
  let rows = memoryRows.get(sessionStore);
  if (!rows) { rows = new Map(); memoryRows.set(sessionStore, rows); }
  const storage = rows;
  const client: Pick<SessionStoreClient, 'rpc'> = {
    async rpc(name, args) {
      const id = args.p_id as string, siteId = args.p_site_id as string, owner = args.p_owner as string;
      try { await sessionStore.assertOwner(id, siteId, owner, 180); }
      catch { return { data: null, error: { code: 'P0002' } }; }
      const key = JSON.stringify([id, siteId]);
      const row = storage.get(key);
      if (name === 'load_harness_host_state') return { data: row ? { ...row } : null, error: null };
      if ((row?.version ?? 0) !== args.p_expected_version) return { data: null, error: { code: 'P0002' } };
      const next = { version: (args.p_expected_version as number) + 1, ciphertext: args.p_ciphertext as string };
      storage.set(key, next);
      return { data: next.version, error: null };
    },
  };
  return createHostStateStore(client, encryptionKey);
}