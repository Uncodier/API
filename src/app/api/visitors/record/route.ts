import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'node:crypto';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CHUNKS_PER_REQUEST = 3;
const MAX_EVENTS_PER_CHUNK = 20_000;
const MIN_RETRY_AFTER_SECONDS = 10;
const MAX_RETRY_AFTER_SECONDS = 30;

interface RecordingChunkInput {
  site_id?: unknown;
  session_id?: unknown;
  visitor_id?: unknown;
  chunk_id?: unknown;
  chunk_timestamp?: unknown;
  timestamp?: unknown;
  url?: unknown;
  events?: unknown;
  metadata?: unknown;
}

interface PreparedRecordingChunk {
  chunkId: string;
  storagePath: string;
  eventsJson: string;
  rpcPayload: {
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
  };
}

class RecordingRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function finiteTimestamp(value: unknown, fallback: number): number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    ? Math.trunc(value)
    : fallback;
}

function isDuplicateStorageObject(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as {
    statusCode?: string | number;
    error?: string;
    message?: string;
  };
  return String(value.statusCode) === '409'
    || value.error === 'Duplicate'
    || /already exists|duplicate/i.test(value.message || '');
}

function retryAfterSeconds(): number {
  return Math.round(
    MIN_RETRY_AFTER_SECONDS
    + Math.random() * (MAX_RETRY_AFTER_SECONDS - MIN_RETRY_AFTER_SECONDS),
  );
}

function deterministicChunkId(value: string): string {
  const hash = createHash('sha256').update(value).digest('hex');
  const variant = ((Number.parseInt(hash[16], 16) & 0x3) | 0x8).toString(16);
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `5${hash.slice(13, 16)}`,
    `${variant}${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join('-');
}

function parseChunks(body: unknown): RecordingChunkInput[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new RecordingRequestError('Invalid recording payload', 400);
  }

  const candidate = body as RecordingChunkInput & { chunks?: unknown };
  const chunks = Array.isArray(candidate.chunks) ? candidate.chunks : [candidate];
  if (chunks.length === 0 || chunks.length > MAX_CHUNKS_PER_REQUEST) {
    throw new RecordingRequestError(
      `Recording batches must contain 1-${MAX_CHUNKS_PER_REQUEST} chunks`,
      400,
    );
  }
  return chunks as RecordingChunkInput[];
}

function prepareChunk(input: RecordingChunkInput): PreparedRecordingChunk | null {
  if (
    !input
    || typeof input !== 'object'
    || Array.isArray(input)
    || typeof input.site_id !== 'string'
    || input.site_id.length === 0
    || typeof input.session_id !== 'string'
    || !UUID_PATTERN.test(input.session_id)
    || !Array.isArray(input.events)
  ) {
    throw new RecordingRequestError('Invalid or incomplete recording chunk', 400);
  }
  if (input.events.length === 0) return null;
  if (input.events.length > MAX_EVENTS_PER_CHUNK) {
    throw new RecordingRequestError('Recording chunk contains too many events', 413);
  }

  if (
    input.chunk_id !== undefined
    && (typeof input.chunk_id !== 'string' || !UUID_PATTERN.test(input.chunk_id))
  ) {
    throw new RecordingRequestError('Invalid recording chunk ID', 400);
  }

  const eventsJson = JSON.stringify(input.events);
  const contentHash = createHash('sha256').update(eventsJson).digest('hex');
  const chunkId =
    typeof input.chunk_id === 'string'
      ? input.chunk_id
      : deterministicChunkId(
        `${input.site_id}/${input.session_id}/${contentHash}`,
      );
  const firstEvent = input.events[0] as { timestamp?: unknown } | undefined;
  const timestamp = finiteTimestamp(
    input.chunk_timestamp,
    finiteTimestamp(input.timestamp, finiteTimestamp(firstEvent?.timestamp, 0)),
  );
  const storagePath =
    `${input.site_id}/${input.session_id}/${timestamp}_${chunkId}_${contentHash}.json`;
  const lastEvent = input.events[input.events.length - 1] as
    | { timestamp?: unknown }
    | undefined;

  return {
    chunkId,
    storagePath,
    eventsJson,
    rpcPayload: {
      event_id: uuidv4(),
      site_id: input.site_id,
      visitor_id:
        typeof input.visitor_id === 'string' && UUID_PATTERN.test(input.visitor_id)
          ? input.visitor_id
          : null,
      session_id: input.session_id,
      url: typeof input.url === 'string' ? input.url : null,
      timestamp,
      storage_path: storagePath,
      chunk_id: chunkId,
      content_hash: contentHash,
      start_timestamp: finiteTimestamp(firstEvent?.timestamp, timestamp),
      end_timestamp: finiteTimestamp(lastEvent?.timestamp, timestamp),
      event_count: input.events.length,
      metadata:
        input.metadata
        && typeof input.metadata === 'object'
        && !Array.isArray(input.metadata)
          ? (input.metadata as Record<string, unknown>)
          : {},
    },
  };
}

async function uploadChunk(chunk: PreparedRecordingChunk): Promise<void> {
  const { error } = await supabaseAdmin
    .storage
    .from('session_recordings')
    .upload(chunk.storagePath, chunk.eventsJson, {
      contentType: 'application/json',
      upsert: false,
    });

  if (error && !isDuplicateStorageObject(error)) {
    console.error('[Session Recording] Storage upload failed:', error);
    throw new RecordingRequestError(
      'Recording storage is temporarily unavailable',
      503,
      retryAfterSeconds(),
    );
  }
}

function databaseError(error: unknown): RecordingRequestError {
  const value = error && typeof error === 'object'
    ? error as { code?: string; message?: string }
    : {};
  if (/identity conflicts|does not belong to site/i.test(value.message || '')) {
    return new RecordingRequestError('Recording chunk conflicts with stored data', 409);
  }
  if (
    value.code === '57014'
    || value.code === '40001'
    || value.code === '40P01'
    || value.code === '53300'
    || value.code?.startsWith('08')
  ) {
    return new RecordingRequestError(
      'Recording database is temporarily unavailable',
      503,
      retryAfterSeconds(),
    );
  }
  return new RecordingRequestError('Could not persist recording metadata', 500);
}

function errorResponse(error: unknown): NextResponse {
  const requestError = error instanceof RecordingRequestError
    ? error
    : new RecordingRequestError('Internal recording error', 500);
  const headers = requestError.retryAfterSeconds === undefined
    ? undefined
    : { 'Retry-After': String(requestError.retryAfterSeconds) };
  return NextResponse.json(
    { success: false, error: requestError.message },
    { status: requestError.status, headers },
  );
}

export async function POST(request: NextRequest) {
  try {
    const preparedChunks = parseChunks(await request.json())
      .map(prepareChunk)
      .filter((chunk): chunk is PreparedRecordingChunk => chunk !== null);

    if (preparedChunks.length === 0) {
      return NextResponse.json({ success: true, accepted: 0 });
    }

    for (const chunk of preparedChunks) {
      await uploadChunk(chunk);
    }

    const { data: recording, error } = await supabaseAdmin.rpc(
      'append_session_recording_chunks',
      { p_chunks: preparedChunks.map((chunk) => chunk.rpcPayload) },
    );
    if (error) {
      console.error('[Session Recording] Metadata batch failed:', error);
      throw databaseError(error);
    }

    const chunks = preparedChunks.map((chunk) => ({
      chunk_id: chunk.chunkId,
      path: chunk.storagePath,
    }));
    return NextResponse.json({
      success: true,
      accepted: chunks.length,
      chunk_id: chunks[0].chunk_id,
      path: chunks[0].path,
      chunks,
      recording,
    });
  } catch (error: unknown) {
    if (!(error instanceof RecordingRequestError)) {
      console.error('[Session Recording] Unhandled error:', error);
    }
    return errorResponse(error);
  }
}
