import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'node:crypto';
import { admitRecordingRequest } from '@/lib/services/session-recording-admission';
import {
  enqueueRecordingMetadata,
  type RecordingMetadataChunk,
} from '@/lib/services/session-recording-queue';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CHUNKS_PER_REQUEST = 3;
const MAX_EVENTS_PER_CHUNK = 20_000;
const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024;
const DEFAULT_MAX_CHUNK_BYTES = 512 * 1024;
const MIN_RETRY_AFTER_SECONDS = 10;
const MAX_RETRY_AFTER_SECONDS = 30;
const RECORDING_METADATA_MAX_BYTES = 256;
const DEVICE_TYPES = new Set(['desktop', 'tablet', 'mobile']);

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
  eventBytes: number;
  rpcPayload: RecordingMetadataChunk;
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

function positiveIntegerSetting(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function readRequestBody(request: NextRequest): Promise<{
  body: unknown;
  bytes: number;
}> {
  const maxBytes = positiveIntegerSetting(
    'SESSION_RECORDING_MAX_REQUEST_BYTES',
    DEFAULT_MAX_REQUEST_BYTES,
  );
  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new RecordingRequestError('Recording request is too large', 413);
  }

  const rawBody = await request.text();
  const bytes = Buffer.byteLength(rawBody);
  if (bytes > maxBytes) {
    throw new RecordingRequestError('Recording request is too large', 413);
  }
  try {
    return { body: JSON.parse(rawBody), bytes };
  } catch {
    throw new RecordingRequestError('Invalid recording payload', 400);
  }
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

function sanitizeMetadata(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const metadata: Record<string, string> = {};

  if (
    typeof source.device_type === 'string'
    && DEVICE_TYPES.has(source.device_type)
  ) {
    metadata.device_type = source.device_type;
  }
  if (
    typeof source.screen_size === 'string'
    && /^\d{1,5}x\d{1,5}$/.test(source.screen_size)
  ) {
    metadata.screen_size = source.screen_size;
  }

  return Buffer.byteLength(JSON.stringify(metadata)) <= RECORDING_METADATA_MAX_BYTES
    ? metadata
    : {};
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
    || !UUID_PATTERN.test(input.site_id)
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
  const eventBytes = Buffer.byteLength(eventsJson);
  const maxChunkBytes = positiveIntegerSetting(
    'SESSION_RECORDING_MAX_CHUNK_BYTES',
    DEFAULT_MAX_CHUNK_BYTES,
  );
  if (eventBytes > maxChunkBytes) {
    throw new RecordingRequestError('Recording chunk is too large', 413);
  }
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
    eventBytes,
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
      metadata: sanitizeMetadata(input.metadata),
    },
  };
}

async function validateSessionOwnership(
  chunks: PreparedRecordingChunk[],
): Promise<void> {
  const sessions = new Map<string, { siteId: string; sessionId: string }>();
  for (const chunk of chunks) {
    const { site_id: siteId, session_id: sessionId } = chunk.rpcPayload;
    sessions.set(`${siteId}\0${sessionId}`, { siteId, sessionId });
  }

  for (const { siteId, sessionId } of Array.from(sessions.values())) {
    const { data, error } = await supabaseAdmin
      .from('visitor_sessions')
      .select('id')
      .eq('id', sessionId)
      .eq('site_id', siteId)
      .maybeSingle();
    if (error) {
      console.error('[Session Recording] Session validation failed:', error);
      throw new RecordingRequestError(
        'Recording session validation is temporarily unavailable',
        503,
        retryAfterSeconds(),
      );
    }
    if (!data) {
      throw new RecordingRequestError(
        'Recording session was not found for this site',
        404,
      );
    }
  }
}

async function uploadChunk(chunk: PreparedRecordingChunk): Promise<boolean> {
  const { error } = await supabaseAdmin
    .storage
    .from('session_recordings')
    .upload(chunk.storagePath, chunk.eventsJson, {
      contentType: 'application/json',
      upsert: false,
    });

  if (error && isDuplicateStorageObject(error)) return false;
  if (error) {
    console.error('[Session Recording] Storage upload failed:', error);
    throw new RecordingRequestError(
      'Recording storage is temporarily unavailable',
      503,
      retryAfterSeconds(),
    );
  }
  return true;
}

async function removeUploadedChunks(
  chunks: PreparedRecordingChunk[],
): Promise<void> {
  if (chunks.length === 0) return;
  const { error } = await supabaseAdmin.storage
    .from('session_recordings')
    .remove(chunks.map((chunk) => chunk.storagePath));
  if (error) {
    console.error('[Session Recording] Could not remove unqueued objects:', error);
  }
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
    const { body, bytes } = await readRequestBody(request);
    const preparedChunks = parseChunks(body)
      .map(prepareChunk)
      .filter((chunk): chunk is PreparedRecordingChunk => chunk !== null);

    if (preparedChunks.length === 0) {
      return NextResponse.json({ success: true, accepted: 0 });
    }

    await validateSessionOwnership(preparedChunks);

    const chunksBySession = new Map<string, PreparedRecordingChunk[]>();
    for (const chunk of preparedChunks) {
      const key = `${chunk.rpcPayload.site_id}\0${chunk.rpcPayload.session_id}`;
      const sessionChunks = chunksBySession.get(key) || [];
      sessionChunks.push(chunk);
      chunksBySession.set(key, sessionChunks);
    }

    const admittedChunks: PreparedRecordingChunk[] = [];
    const droppedReasons: string[] = [];
    const totalEventBytes = preparedChunks.reduce(
      (total, chunk) => total + chunk.eventBytes,
      0,
    );
    for (const sessionChunks of Array.from(chunksBySession.values())) {
      const first = sessionChunks[0].rpcPayload;
      const sessionEventBytes = sessionChunks.reduce(
        (total, chunk) => total + chunk.eventBytes,
        0,
      );
      const admission = await admitRecordingRequest({
        siteId: first.site_id,
        sessionId: first.session_id,
        requestBytes: Math.max(
          1,
          Math.ceil(bytes * sessionEventBytes / totalEventBytes),
        ),
      });
      if (admission.accepted) admittedChunks.push(...sessionChunks);
      else droppedReasons.push(admission.reason);
    }

    if (admittedChunks.length === 0) {
      return NextResponse.json(
        {
          success: true,
          accepted: 0,
          dropped: preparedChunks.length,
          reason: droppedReasons[0] || 'admission_rejected',
        },
        { status: 202 },
      );
    }

    const uploadedChunks: PreparedRecordingChunk[] = [];
    try {
      for (const chunk of admittedChunks) {
        if (await uploadChunk(chunk)) uploadedChunks.push(chunk);
      }
    } catch (error) {
      await removeUploadedChunks(uploadedChunks);
      throw error;
    }

    try {
      const messageId = await enqueueRecordingMetadata(
        admittedChunks.map((chunk) => chunk.rpcPayload),
      );
      if (messageId === null) {
        await removeUploadedChunks(uploadedChunks);
        return NextResponse.json(
          {
            success: true,
            accepted: 0,
            dropped: preparedChunks.length,
            reason: 'queue_backlog',
          },
          { status: 202 },
        );
      }
    } catch (error) {
      console.error('[Session Recording] Metadata queue failed:', error);
      await removeUploadedChunks(uploadedChunks);
      throw new RecordingRequestError(
        'Recording metadata queue is temporarily unavailable',
        503,
        retryAfterSeconds(),
      );
    }

    const chunks = admittedChunks.map((chunk) => ({
      chunk_id: chunk.chunkId,
      path: chunk.storagePath,
    }));
    return NextResponse.json({
      success: true,
      accepted: chunks.length,
      dropped: preparedChunks.length - admittedChunks.length,
      chunk_id: chunks[0].chunk_id,
      path: chunks[0].path,
      chunks,
      queued: true,
    });
  } catch (error: unknown) {
    if (!(error instanceof RecordingRequestError)) {
      console.error('[Session Recording] Unhandled error:', error);
    }
    return errorResponse(error);
  }
}
