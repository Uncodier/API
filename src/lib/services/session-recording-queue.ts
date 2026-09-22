import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { getTrackingRedisClient } from '@/lib/utils/tracking-redis-client';

const STREAM_KEY = 'recording:{metadata}:pending';
const DEAD_LETTER_STREAM_KEY = 'recording:{metadata}:dead-letter';
const WORKER_LOCK_KEY = 'recording:{metadata}:worker-lock';
const WORKER_LOCK_SECONDS = 90;
const MAX_CHUNKS_PER_RPC = 10;
const DEFAULT_MAX_QUEUE_MESSAGES = 300;
const DEFAULT_MAX_DEAD_LETTER_MESSAGES = 1_000;

const ENQUEUE_SCRIPT = `
  if redis.call('XLEN', KEYS[1]) >= tonumber(ARGV[1]) then
    return false
  end
  return redis.call('XADD', KEYS[1], '*', 'payload', ARGV[2])
`;

export interface RecordingMetadataChunk {
  event_id: string;
  site_id: string;
  visitor_id: string | null;
  session_id: string;
  url: string | null;
  timestamp: number;
  storage_path: string;
  chunk_id: string;
  content_hash: string;
  start_timestamp: number;
  end_timestamp: number;
  event_count: number;
  metadata: Record<string, unknown>;
}

export interface RecordingQueueDrainResult {
  state: 'busy' | 'empty' | 'processed';
  messages: number;
  chunks: number;
  rpcCalls: number;
  deadLetters: number;
  remaining: number;
}

interface StreamEntry {
  id: string;
  payload: string;
  chunks: RecordingMetadataChunk[];
}

function positiveIntegerSetting(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : fallback;
}

function fieldsToRecord(fields: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < fields.length; index += 2) {
    result[fields[index]] = fields[index + 1];
  }
  return result;
}

function parseEntry(value: unknown): StreamEntry {
  if (!Array.isArray(value) || typeof value[0] !== 'string' || !Array.isArray(value[1])) {
    throw new Error('Invalid Redis stream entry');
  }
  const fields = fieldsToRecord(value[1].map(String));
  const parsed = JSON.parse(fields.payload || 'null') as unknown;
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 3) {
    throw new Error('Invalid recording metadata payload');
  }
  return {
    id: value[0],
    payload: fields.payload,
    chunks: parsed as RecordingMetadataChunk[],
  };
}

interface RpcError {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
  status?: number;
}

function isPermanentRpcError(error: RpcError): boolean {
  const code = error.code || '';
  if (
    code.startsWith('08')
    || code.startsWith('40')
    || code.startsWith('53')
    || code.startsWith('57')
    || code.startsWith('58')
    || code === '55P03'
  ) {
    return false;
  }
  if (
    code === 'P0001'
    || code.startsWith('22')
    || code.startsWith('23')
    || code.startsWith('42')
    || code.startsWith('PGRST1')
    || code.startsWith('PGRST2')
  ) {
    return true;
  }
  return typeof error.status === 'number'
    && error.status >= 400
    && error.status < 500
    && error.status !== 408
    && error.status !== 429;
}

function rpcErrorMessage(error: RpcError): string {
  return [error.message, error.details, error.hint]
    .filter(Boolean)
    .join(' | ')
    || 'Unknown recording persistence error';
}

async function addDeadLetter(
  entry: Pick<StreamEntry, 'id' | 'payload'>,
  error: string,
  errorCode?: string,
): Promise<void> {
  const fields = [
    'source_id',
    entry.id,
    'payload',
    entry.payload,
    'error',
    error,
  ];
  if (errorCode) fields.push('error_code', errorCode);
  await getTrackingRedisClient().xadd(
    DEAD_LETTER_STREAM_KEY,
    'MAXLEN',
    '~',
    positiveIntegerSetting(
      'SESSION_RECORDING_DEAD_LETTER_MAX_MESSAGES',
      DEFAULT_MAX_DEAD_LETTER_MESSAGES,
    ),
    '*',
    ...fields,
  );
}

function groupEntries(entries: StreamEntry[]): StreamEntry[][] {
  const groups: StreamEntry[][] = [];
  let group: StreamEntry[] = [];
  let chunkCount = 0;
  for (const entry of entries) {
    if (group.length > 0 && chunkCount + entry.chunks.length > MAX_CHUNKS_PER_RPC) {
      groups.push(group);
      group = [];
      chunkCount = 0;
    }
    group.push(entry);
    chunkCount += entry.chunks.length;
  }
  if (group.length > 0) groups.push(group);
  return groups;
}

async function releaseWorkerLock(token: string): Promise<void> {
  const redis = getTrackingRedisClient();
  await redis.eval(
    `
      if redis.call('GET', KEYS[1]) == ARGV[1] then
        return redis.call('DEL', KEYS[1])
      end
      return 0
    `,
    1,
    WORKER_LOCK_KEY,
    token,
  );
}

export async function enqueueRecordingMetadata(
  chunks: RecordingMetadataChunk[],
): Promise<string | null> {
  if (!process.env.REDIS_STREAMS_URL?.trim() && !process.env.REDIS_URL?.trim()) {
    throw new Error(
      'REDIS_STREAMS_URL or REDIS_URL is required for recording metadata',
    );
  }
  if (chunks.length < 1 || chunks.length > 3) {
    throw new Error('Recording metadata messages must contain 1-3 chunks');
  }
  const messageId = await getTrackingRedisClient().eval(
    ENQUEUE_SCRIPT,
    1,
    STREAM_KEY,
    positiveIntegerSetting(
      'SESSION_RECORDING_QUEUE_MAX_MESSAGES',
      DEFAULT_MAX_QUEUE_MESSAGES,
    ),
    JSON.stringify(chunks),
  );
  if (messageId === null || messageId === false || messageId === 0) return null;
  if (typeof messageId !== 'string') {
    throw new Error('Could not enqueue recording metadata');
  }
  return messageId;
}

export async function drainRecordingMetadataQueue(
  client: SupabaseClient = supabaseAdmin,
): Promise<RecordingQueueDrainResult> {
  if (!process.env.REDIS_STREAMS_URL?.trim() && !process.env.REDIS_URL?.trim()) {
    throw new Error(
      'REDIS_STREAMS_URL or REDIS_URL is required for recording metadata',
    );
  }

  const redis = getTrackingRedisClient();
  const lockToken = randomUUID();
  const lock = await redis.set(
    WORKER_LOCK_KEY,
    lockToken,
    'EX',
    WORKER_LOCK_SECONDS,
    'NX',
  );
  if (lock !== 'OK') {
    return {
      state: 'busy',
      messages: 0,
      chunks: 0,
      rpcCalls: 0,
      deadLetters: 0,
      remaining: await redis.xlen(STREAM_KEY),
    };
  }

  try {
    const maxMessages = Math.min(
      positiveIntegerSetting('SESSION_RECORDING_QUEUE_MESSAGES_PER_RUN', 30),
      100,
    );
    const rawEntries = await redis.xrange(
      STREAM_KEY,
      '-',
      '+',
      'COUNT',
      maxMessages,
    ) as unknown[];
    if (rawEntries.length === 0) {
      return {
        state: 'empty',
        messages: 0,
        chunks: 0,
        rpcCalls: 0,
        deadLetters: 0,
        remaining: 0,
      };
    }

    const entries: StreamEntry[] = [];
    const deadLetterIds: string[] = [];
    for (const rawEntry of rawEntries) {
      try {
        entries.push(parseEntry(rawEntry));
      } catch (error) {
        const id = Array.isArray(rawEntry) ? String(rawEntry[0]) : 'unknown';
        const payload = Array.isArray(rawEntry) && Array.isArray(rawEntry[1])
          ? fieldsToRecord(rawEntry[1].map(String)).payload || ''
          : '';
        await addDeadLetter(
          { id, payload },
          error instanceof Error ? error.message : 'Invalid queue entry',
        );
        if (id !== 'unknown') deadLetterIds.push(id);
      }
    }

    let rpcCalls = 0;
    const persistedIds: string[] = [];
    let persistedChunks = 0;

    const persistEntries = async (batchEntries: StreamEntry[]): Promise<void> => {
      const batch = batchEntries.flatMap((entry) => entry.chunks);
      rpcCalls += 1;
      const { error } = await client.rpc('append_session_recording_chunks', {
        p_chunks: batch,
      });
      if (!error) {
        persistedIds.push(...batchEntries.map((entry) => entry.id));
        persistedChunks += batch.length;
        return;
      }

      const rpcError = error as RpcError;
      if (!isPermanentRpcError(rpcError)) {
        throw new Error(
          `Could not persist recording metadata: ${rpcErrorMessage(rpcError)}`,
        );
      }

      if (batchEntries.length === 1) {
        await addDeadLetter(
          batchEntries[0],
          rpcErrorMessage(rpcError),
          rpcError.code,
        );
        deadLetterIds.push(batchEntries[0].id);
        return;
      }

      const midpoint = Math.floor(batchEntries.length / 2);
      await persistEntries(batchEntries.slice(0, midpoint));
      await persistEntries(batchEntries.slice(midpoint));
    };

    try {
      for (const group of groupEntries(entries)) {
        await persistEntries(group);
      }
    } catch (error) {
      const handledIds = Array.from(
        new Set([...deadLetterIds, ...persistedIds]),
      );
      if (handledIds.length > 0) await redis.xdel(STREAM_KEY, ...handledIds);
      throw error;
    }

    const handledIds = Array.from(
      new Set([...deadLetterIds, ...persistedIds]),
    );
    if (handledIds.length > 0) await redis.xdel(STREAM_KEY, ...handledIds);

    return {
      state: 'processed',
      messages: entries.length,
      chunks: persistedChunks,
      rpcCalls,
      deadLetters: deadLetterIds.length,
      remaining: await redis.xlen(STREAM_KEY),
    };
  } finally {
    await releaseWorkerLock(lockToken).catch((error) => {
      console.error('[Session Recording] Could not release queue lock:', error);
    });
  }
}
