import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { getTrackingRedisClient } from '@/lib/utils/tracking-redis-client';
import type { QueuedTrackingEvent } from './tracking-event-ingest';

const STREAM_KEY = 'tracking:{events}:pending';
const DEAD_LETTER_STREAM_KEY = 'tracking:{events}:dead-letter';
const GROUP_NAME = 'tracking-database';
const WORKER_LOCK_KEY = 'tracking:{events}:worker-lock';
const WORKER_LOCK_SECONDS = 90;
const DEFAULT_EVENTS_PER_RUN = 500;
const DEFAULT_MESSAGES_PER_RUN = 100;
const DEFAULT_EVENTS_PER_MESSAGE = 100;
const DEFAULT_CLAIM_IDLE_MS = 60_000;

const ACK_AND_DELETE_SCRIPT = `
  local acknowledged = 0
  for index = 2, #ARGV do
    acknowledged = acknowledged + redis.call(
      'XACK',
      KEYS[1],
      ARGV[1],
      ARGV[index]
    )
  end
  redis.call('XDEL', KEYS[1], unpack(ARGV, 2))
  return acknowledged
`;

const DEAD_LETTER_SCRIPT = `
  redis.call(
    'XADD',
    KEYS[2],
    '*',
    'source_id',
    ARGV[2],
    'payload',
    ARGV[3],
    'error',
    ARGV[4],
    'error_code',
    ARGV[5]
  )
  redis.call('XACK', KEYS[1], ARGV[1], ARGV[2])
  redis.call('XDEL', KEYS[1], ARGV[2])
  return 1
`;

export interface TrackingQueueDrainResult {
  state: 'busy' | 'empty' | 'processed';
  messages: number;
  events: number;
  deadLetters: number;
  remaining: number;
}

interface TrackingStreamEntry {
  id: string;
  payload: string;
  events: QueuedTrackingEvent[];
}

interface RpcError {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
  status?: number;
}

function positiveIntegerSetting(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function fieldsToRecord(fields: unknown[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (let index = 0; index < fields.length; index += 2) {
    record[String(fields[index])] = String(fields[index + 1]);
  }
  return record;
}

function parseEntry(value: unknown): TrackingStreamEntry {
  if (!Array.isArray(value) || typeof value[0] !== 'string' || !Array.isArray(value[1])) {
    throw new Error('Invalid tracking stream entry');
  }
  const fields = fieldsToRecord(value[1]);
  const parsed = JSON.parse(fields.payload || 'null') as {
    version?: unknown;
    events?: unknown;
  } | null;
  if (
    !parsed
    || parsed.version !== 1
    || !Array.isArray(parsed.events)
    || parsed.events.length < 1
    || parsed.events.length > DEFAULT_EVENTS_PER_MESSAGE
  ) {
    throw new Error('Invalid tracking queue payload');
  }
  return {
    id: value[0],
    payload: fields.payload,
    events: parsed.events as QueuedTrackingEvent[],
  };
}

function rpcErrorMessage(error: RpcError): string {
  return [error.message, error.details, error.hint]
    .filter(Boolean)
    .join(' | ') || 'Unknown tracking persistence error';
}

function isPermanentRpcError(error: RpcError): boolean {
  const code = error.code || '';
  if (
    code.startsWith('08')
    || code.startsWith('40')
    || code.startsWith('53')
    || code.startsWith('55')
    || code.startsWith('57')
    || code.startsWith('58')
    || code.startsWith('PGRST')
    || code.startsWith('42')
  ) {
    return false;
  }
  return code === 'P0001' || code.startsWith('22') || code.startsWith('23');
}

async function ensureConsumerGroup(): Promise<void> {
  try {
    await getTrackingRedisClient().xgroup(
      'CREATE',
      STREAM_KEY,
      GROUP_NAME,
      '0',
      'MKSTREAM',
    );
  } catch (error) {
    if (!/BUSYGROUP/i.test(error instanceof Error ? error.message : String(error))) {
      throw error;
    }
  }
}

async function readEntries(
  consumer: string,
  count: number,
): Promise<unknown[]> {
  const redis = getTrackingRedisClient();
  const claimed = await redis.xautoclaim(
    STREAM_KEY,
    GROUP_NAME,
    consumer,
    positiveIntegerSetting('TRACKING_QUEUE_CLAIM_IDLE_MS', DEFAULT_CLAIM_IDLE_MS),
    '0-0',
    'COUNT',
    count,
  ) as unknown;
  const claimedEntries = Array.isArray(claimed) && Array.isArray(claimed[1])
    ? claimed[1] as unknown[]
    : [];
  if (claimedEntries.length >= count) return claimedEntries;

  const fresh = await redis.xreadgroup(
    'GROUP',
    GROUP_NAME,
    consumer,
    'COUNT',
    count - claimedEntries.length,
    'STREAMS',
    STREAM_KEY,
    '>',
  ) as unknown;
  const freshEntries =
    Array.isArray(fresh)
    && Array.isArray(fresh[0])
    && Array.isArray(fresh[0][1])
      ? fresh[0][1] as unknown[]
      : [];
  return [...claimedEntries, ...freshEntries];
}

async function acknowledge(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await getTrackingRedisClient().eval(
    ACK_AND_DELETE_SCRIPT,
    1,
    STREAM_KEY,
    GROUP_NAME,
    ...ids,
  );
}

async function deadLetter(
  entry: Pick<TrackingStreamEntry, 'id' | 'payload'>,
  error: string,
  errorCode = '',
): Promise<void> {
  await getTrackingRedisClient().eval(
    DEAD_LETTER_SCRIPT,
    2,
    STREAM_KEY,
    DEAD_LETTER_STREAM_KEY,
    GROUP_NAME,
    entry.id,
    entry.payload,
    error,
    errorCode,
  );
}

async function releaseWorkerLock(token: string): Promise<void> {
  await getTrackingRedisClient().eval(
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

export async function enqueueTrackingEvents(
  events: QueuedTrackingEvent[],
): Promise<string> {
  if (events.length < 1 || events.length > DEFAULT_EVENTS_PER_MESSAGE) {
    throw new Error('Tracking messages must contain 1-100 events');
  }
  const messageId = await getTrackingRedisClient().xadd(
    STREAM_KEY,
    '*',
    'payload',
    JSON.stringify({ version: 1, events }),
  );
  if (!messageId) throw new Error('Could not enqueue tracking events');
  return messageId;
}

export async function drainTrackingEventQueue(
  client: SupabaseClient = supabaseAdmin,
): Promise<TrackingQueueDrainResult> {
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
      events: 0,
      deadLetters: 0,
      remaining: await redis.xlen(STREAM_KEY),
    };
  }

  try {
    await ensureConsumerGroup();
    const maxEvents = Math.min(
      positiveIntegerSetting('TRACKING_QUEUE_EVENTS_PER_RUN', DEFAULT_EVENTS_PER_RUN),
      5_000,
    );
    const maxMessages = Math.min(
      positiveIntegerSetting(
        'TRACKING_QUEUE_MESSAGES_PER_RUN',
        DEFAULT_MESSAGES_PER_RUN,
      ),
      1_000,
    );
    const rawEntries = await readEntries(
      `tracking-${randomUUID()}`,
      maxMessages,
    );
    if (rawEntries.length === 0) {
      return {
        state: 'empty',
        messages: 0,
        events: 0,
        deadLetters: 0,
        remaining: await redis.xlen(STREAM_KEY),
      };
    }

    const entries: TrackingStreamEntry[] = [];
    let selectedEvents = 0;
    let deadLetters = 0;
    for (const rawEntry of rawEntries) {
      try {
        const entry = parseEntry(rawEntry);
        if (
          entries.length > 0
          && selectedEvents + entry.events.length > maxEvents
        ) {
          break;
        }
        entries.push(entry);
        selectedEvents += entry.events.length;
      } catch (error) {
        const id = Array.isArray(rawEntry) ? String(rawEntry[0]) : 'unknown';
        const fields =
          Array.isArray(rawEntry) && Array.isArray(rawEntry[1])
            ? fieldsToRecord(rawEntry[1])
            : {};
        if (id !== 'unknown') {
          await deadLetter(
            { id, payload: fields.payload || '' },
            error instanceof Error ? error.message : 'Invalid queue entry',
          );
          deadLetters += 1;
        }
      }
    }

    const groups: TrackingStreamEntry[][] = [];
    let group: TrackingStreamEntry[] = [];
    let groupEvents = 0;
    for (const entry of entries) {
      if (
        group.length > 0
        && groupEvents + entry.events.length > DEFAULT_EVENTS_PER_MESSAGE
      ) {
        groups.push(group);
        group = [];
        groupEvents = 0;
      }
      group.push(entry);
      groupEvents += entry.events.length;
    }
    if (group.length > 0) groups.push(group);

    let messages = 0;
    let events = 0;
    const persistEntries = async (
      batchEntries: TrackingStreamEntry[],
    ): Promise<void> => {
      const batch = batchEntries.flatMap((entry) => entry.events);
      const { error } = await client.rpc('persist_tracking_event_batch', {
        p_events: batch,
      });
      if (error) {
        const rpcError = error as RpcError;
        if (!isPermanentRpcError(rpcError)) {
          throw new Error(
            `Could not persist tracking events: ${rpcErrorMessage(rpcError)}`,
          );
        }
        if (batchEntries.length > 1) {
          const midpoint = Math.floor(batchEntries.length / 2);
          await persistEntries(batchEntries.slice(0, midpoint));
          await persistEntries(batchEntries.slice(midpoint));
          return;
        }
        await deadLetter(
          batchEntries[0],
          rpcErrorMessage(rpcError),
          rpcError.code,
        );
        deadLetters += 1;
        messages += 1;
        return;
      }

      await acknowledge(batchEntries.map((entry) => entry.id));
      messages += batchEntries.length;
      events += batch.length;
    };

    for (const batchEntries of groups) {
      await persistEntries(batchEntries);
    }

    return {
      state: 'processed',
      messages,
      events,
      deadLetters,
      remaining: await redis.xlen(STREAM_KEY),
    };
  } finally {
    await releaseWorkerLock(lockToken).catch((error) => {
      console.error('[Tracking Queue] Could not release worker lock:', error);
    });
  }
}
