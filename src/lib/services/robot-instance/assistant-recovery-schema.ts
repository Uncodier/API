import type { RecoveryToolObservation } from './assistant-recovery-context';

export type AssistantRecoveryScope = {
  instanceId: string;
  siteId: string;
  userId: string;
  userMessageLogId: string;
  /** Workflow ownership fence. Initial executions own generation zero. */
  generation?: number;
};

export type AssistantRecoveryExecution = {
  customTools: unknown[];
  useSdkTools: boolean;
  systemPrompt?: string;
  agentType?: string;
  userPhone?: string;
  instanceNodeId?: string;
  expectedResultsAmount?: number;
  contextString?: string;
  toolOverrides?: Record<string, unknown>;
  selectedSkills?: unknown;
  approvedImport?: unknown;
};

export type AssistantRecoverySnapshot = {
  version: 1;
  /** Mandatory CAS fence; refreshed by every recovery-state write. */
  revision: string;
  execution: AssistantRecoveryExecution;
  nodeFingerprint?: string;
  messages: unknown[];
  continuation?: { responseNodeIds: string[] };
  inFlight: boolean;
  /** Optional for checkpoints written before heuristic recovery was introduced. */
  inFlightSince?: string;
  inFlightKind?: 'turn' | 'plan';
  lastActivityAt?: string;
  toolObservations?: RecoveryToolObservation[];
  interruptionContext?: string;
  respawnCount: number;
  lease_token?: string;
};

export type RecoveryErrorCode =
  | 'inactive' | 'missing' | 'context_changed' | 'in_flight'
  | 'limit' | 'conflict' | 'invalid_state';

/** Safe to surface as a pause reason; never includes prompts, URLs, or DB errors. */
export class RecoveryError extends Error {
  readonly code: RecoveryErrorCode;

  constructor(code: RecoveryErrorCode) {
    super(`Assistant recovery unavailable: ${code}`);
    this.name = 'RecoveryError';
    this.code = code;
    Object.setPrototypeOf(this, RecoveryError.prototype);
  }
}

export const MAX_RECOVERY_MESSAGES_BYTES = 512 * 1024;
export const MAX_RECOVERY_RESPAWNS = 2;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATA_URL = /\bdata:[^\s,;]*[;,]/i;

export function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** JSON.stringify alone silently loses functions, undefined, receipts, and non-finite values. */
export function cloneRecoveryJson<T>(value: T, maxBytes: number, rejectDataUrls = true): T {
  const ancestors = new Set<object>();
  let visited = 0;
  function visit(input: unknown, depth: number): unknown {
    if (++visited > 200_000 || depth > 64) throw new RecoveryError('invalid_state');
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (typeof input === 'string') {
      if (Buffer.byteLength(input, 'utf8') > maxBytes || (rejectDataUrls && DATA_URL.test(input))) {
        throw new RecoveryError('invalid_state');
      }
      return input;
    }
    if (typeof input !== 'object' || !input || (!Array.isArray(input) && !isRecord(input))) {
      throw new RecoveryError('invalid_state');
    }
    if (ancestors.has(input)) throw new RecoveryError('invalid_state');
    ancestors.add(input);
    const keys = Reflect.ownKeys(input);
    const output: unknown[] | Record<string, unknown> = Array.isArray(input) ? [] : {};
    if (Array.isArray(input) && keys.length !== input.length + 1) throw new RecoveryError('invalid_state');
    for (const key of keys) {
      if (Array.isArray(input) && key === 'length') continue;
      if (typeof key !== 'string' || (rejectDataUrls && DATA_URL.test(key))) {
        throw new RecoveryError('invalid_state');
      }
      const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
      if (!descriptor.enumerable || !('value' in descriptor)) throw new RecoveryError('invalid_state');
      if (Array.isArray(input) && !/^(0|[1-9]\d*)$/.test(key)) throw new RecoveryError('invalid_state');
      Object.defineProperty(output, key, {
        value: visit(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true,
      });
    }
    ancestors.delete(input);
    return output;
  }
  try {
    const cloned = visit(value, 0);
    if (Buffer.byteLength(JSON.stringify(cloned), 'utf8') > maxBytes) throw new RecoveryError('invalid_state');
    return cloned as T;
  } catch (error) {
    if (error instanceof RecoveryError) throw error;
    throw new RecoveryError('invalid_state');
  }
}

export function canonicalRecoveryJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalRecoveryJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalRecoveryJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function onlyKeys(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new RecoveryError('invalid_state');
}

export function assertRecoveryScope(scope: AssistantRecoveryScope): void {
  if (!isRecord(scope) || (['instanceId', 'siteId', 'userId', 'userMessageLogId'] as const).some(key =>
    typeof scope[key] !== 'string' || !scope[key].trim() || scope[key].length > 200)) {
    throw new RecoveryError('missing');
  }
  if (scope.generation !== undefined && (!Number.isSafeInteger(scope.generation) || scope.generation < 0)) {
    throw new RecoveryError('invalid_state');
  }
}

export function parseRecoveryExecution(value: unknown): AssistantRecoveryExecution {
  if (!isRecord(value)) throw new RecoveryError('invalid_state');
  const stringKeys = ['systemPrompt', 'agentType', 'userPhone', 'instanceNodeId', 'contextString'];
  const optionalKeys = [...stringKeys, 'expectedResultsAmount', 'toolOverrides', 'selectedSkills', 'approvedImport'];
  onlyKeys(value, ['customTools', 'useSdkTools', ...optionalKeys]);
  // Absent optional arguments are common at the workflow boundary. Only this top-level
  // omission is permitted; nested undefined values could erase a tool receipt.
  const present: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new RecoveryError('invalid_state');
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !('value' in descriptor)) throw new RecoveryError('invalid_state');
    if (descriptor.value === undefined && optionalKeys.includes(key)) continue;
    present[key] = descriptor.value;
  }
  const result = cloneRecoveryJson(present, MAX_RECOVERY_MESSAGES_BYTES);
  if (!Array.isArray(result.customTools) || typeof result.useSdkTools !== 'boolean' ||
      stringKeys.some(key => key in result && typeof result[key] !== 'string') ||
      ('instanceNodeId' in result && !(result.instanceNodeId as string).trim()) ||
      ('toolOverrides' in result && !isRecord(result.toolOverrides)) ||
      ('expectedResultsAmount' in result && (!Number.isSafeInteger(result.expectedResultsAmount) ||
        (result.expectedResultsAmount as number) < 1))) {
    throw new RecoveryError('invalid_state');
  }
  return result as AssistantRecoveryExecution;
}

export function parseRecoveryCheckpoint(value: unknown): Pick<AssistantRecoverySnapshot, 'messages' | 'continuation'> {
  const result = cloneRecoveryJson(value, MAX_RECOVERY_MESSAGES_BYTES + 64 * 1024);
  if (!isRecord(result) || !Array.isArray(result.messages)) throw new RecoveryError('invalid_state');
  onlyKeys(result, ['messages', 'continuation']);
  cloneRecoveryJson(result.messages, MAX_RECOVERY_MESSAGES_BYTES);
  if ('continuation' in result) {
    const continuation = result.continuation;
    if (!isRecord(continuation)) throw new RecoveryError('invalid_state');
    onlyKeys(continuation, ['responseNodeIds']);
    const ids = continuation.responseNodeIds;
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id.trim() || id.length > 200) ||
        new Set(ids).size !== ids.length) throw new RecoveryError('invalid_state');
  }
  return result as Pick<AssistantRecoverySnapshot, 'messages' | 'continuation'>;
}

export function parseRecoverySnapshot(value: unknown): AssistantRecoverySnapshot {
  const result = cloneRecoveryJson(value, 2 * MAX_RECOVERY_MESSAGES_BYTES + 64 * 1024);
  if (!isRecord(result)) throw new RecoveryError('invalid_state');
  onlyKeys(result, ['version', 'revision', 'execution', 'nodeFingerprint', 'messages', 'continuation', 'inFlight', 'respawnCount', 'lease_token',
    'inFlightSince', 'inFlightKind', 'lastActivityAt', 'toolObservations', 'interruptionContext']);
  if (result.version !== 1 || typeof result.revision !== 'string' || !UUID.test(result.revision) || typeof result.inFlight !== 'boolean' ||
      !Number.isSafeInteger(result.respawnCount) || (result.respawnCount as number) < 0 ||
      ('lease_token' in result && (typeof result.lease_token !== 'string' || !UUID.test(result.lease_token)))) {
    throw new RecoveryError('invalid_state');
  }
  for (const key of ['inFlightSince', 'lastActivityAt']) {
    if (key in result && (typeof result[key] !== 'string' || !Number.isFinite(Date.parse(result[key] as string)))) {
      throw new RecoveryError('invalid_state');
    }
  }
  if ('inFlightKind' in result && result.inFlightKind !== 'turn' && result.inFlightKind !== 'plan') {
    throw new RecoveryError('invalid_state');
  }
  if ('interruptionContext' in result && (typeof result.interruptionContext !== 'string' ||
      Buffer.byteLength(result.interruptionContext, 'utf8') > 24 * 1024 || DATA_URL.test(result.interruptionContext))) {
    throw new RecoveryError('invalid_state');
  }
  if ('toolObservations' in result) {
    if (!Array.isArray(result.toolObservations) || result.toolObservations.length > 8) throw new RecoveryError('invalid_state');
    for (const observation of result.toolObservations) {
      if (!isRecord(observation)) throw new RecoveryError('invalid_state');
      onlyKeys(observation, ['name', 'args', 'outcome', 'result', 'observedAt']);
      if (typeof observation.name !== 'string' || Buffer.byteLength(observation.name) > 128 ||
          typeof observation.args !== 'string' || Buffer.byteLength(observation.args) > 1024 ||
          !['unknown', 'returned', 'threw'].includes(observation.outcome as string) ||
          typeof observation.observedAt !== 'string' || !Number.isFinite(Date.parse(observation.observedAt)) ||
          ('result' in observation && (typeof observation.result !== 'string' || Buffer.byteLength(observation.result) > 1024))) {
        throw new RecoveryError('invalid_state');
      }
    }
  }
  const execution = parseRecoveryExecution(result.execution);
  if (execution.instanceNodeId
    ? typeof result.nodeFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(result.nodeFingerprint)
    : 'nodeFingerprint' in result) throw new RecoveryError('invalid_state');
  parseRecoveryCheckpoint({ messages: result.messages, ...('continuation' in result ? { continuation: result.continuation } : {}) });
  return { ...result, execution } as AssistantRecoverySnapshot;
}