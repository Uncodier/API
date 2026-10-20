import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';

export const INSTANCE_HISTORY_LIMITS = {
  list: 20,
  previewChars: 600,
  readChars: 12_000,
  queryChars: 200,
  logTypeChars: 100,
  toolNameChars: 200,
  statusChars: 100,
  thoughtProcessChars: 2_000,
} as const;

export const INSTANCE_HISTORY_DEFAULTS = { list: 10, readChars: 4_000 } as const;

const uuid = z.string().uuid();
const safeInteger = z.number().finite().int().min(0).max(Number.MAX_SAFE_INTEGER);
// The tools router adds this field to child schemas. Accept but never persist,
// query with, or echo it; all other unknown fields still fail closed.
const thoughtProcess = z.string().max(INSTANCE_HISTORY_LIMITS.thoughtProcessChars).optional();
const cursorSchema = z.object({
  // Keep the original fractional seconds: Date.toISOString() would lose
  // Postgres microseconds, creating holes/duplicates in a timestamp keyset.
  created_at: z.string().max(40).datetime({ offset: true })
    .refine(value => Number.isFinite(Date.parse(value)), 'Invalid timestamp'),
  id: uuid,
}).strict();

const listArgsSchema = z.object({
  action: z.enum(['list']),
  thought_process: thoughtProcess,
  query: z.string().min(1).max(INSTANCE_HISTORY_LIMITS.queryChars)
    .regex(/^(?=[\s\S]*\S)[^\0]*$/, 'Use a non-empty query without NUL characters')
    .optional(),
  log_type: z.string().min(1).max(INSTANCE_HISTORY_LIMITS.logTypeChars)
    .regex(/^(?=[\s\S]*\S)[^\0]*$/, 'Use a non-empty log_type without NUL characters')
    .optional(),
  before: cursorSchema.optional(),
  limit: safeInteger.min(1).max(INSTANCE_HISTORY_LIMITS.list).default(INSTANCE_HISTORY_DEFAULTS.list),
}).strict();
const readArgsSchema = z.object({
  action: z.enum(['read']),
  thought_process: thoughtProcess,
  log_id: uuid,
  offset: safeInteger.default(0),
  limit: safeInteger.min(1).max(INSTANCE_HISTORY_LIMITS.readChars).default(INSTANCE_HISTORY_DEFAULTS.readChars),
}).strict();
const argsSchema = z.discriminatedUnion('action', [listArgsSchema, readArgsSchema]);

// A root union is not portable to strict tool providers. Nest the discriminated
// request instead: all model properties are required, with explicit null only
// for active-action defaults. Legacy flat arguments retain their strict contract.
export const instanceHistoryModelArgsSchema = z.object({
  request: z.discriminatedUnion('action', [
    listArgsSchema.omit({ thought_process: true }).extend({
      query: listArgsSchema.shape.query.unwrap().nullable()
        .describe('Literal case-insensitive substring of message, not tool payloads. Null means no query filter.'),
      log_type: listArgsSchema.shape.log_type.unwrap().nullable()
        .describe('Exact log type. Null means all log types.'),
      before: cursorSchema.nullable()
        .describe('Prior next_cursor unchanged, preserving timestamp precision. Null starts the first page.'),
      limit: listArgsSchema.shape.limit.removeDefault().nullable()
        .describe(`Number of logs, max ${INSTANCE_HISTORY_LIMITS.list}. Null uses ${INSTANCE_HISTORY_DEFAULTS.list}.`),
    }),
    readArgsSchema.omit({ thought_process: true }).extend({
      log_id: uuid.describe('Required log UUID returned by list.'),
      offset: readArgsSchema.shape.offset.removeDefault().nullable()
        .describe('Nonnegative UTF-16 offset. Null starts at 0; can jump directly to the tail.'),
      limit: readArgsSchema.shape.limit.removeDefault().nullable()
        .describe(`UTF-16 characters, max ${INSTANCE_HISTORY_LIMITS.readChars}. Null uses ${INSTANCE_HISTORY_DEFAULTS.readChars}.`),
    }),
  ]).describe('Choose exactly one action. Never include list fields in read, or read fields in list.'),
  thought_process: thoughtProcess.unwrap().describe('Brief reason for the call; use an empty string if unnecessary. Never persisted or used as authorization.'),
}).strict();

export type InstanceHistoryArgs = z.input<typeof argsSchema> | z.input<typeof instanceHistoryModelArgsSchema>;
export type InstanceHistoryCursor = z.infer<typeof cursorSchema>;

export interface InstanceHistoryLogContent {
  message?: string | null;
  tool_args?: unknown;
  tool_result?: unknown;
  details?: unknown;
}

/**
 * Canonical full text used by history readers. No prefixes or pre-truncation:
 * all offsets/lengths refer to this JSON string's UTF-16 code units. Missing
 * fields are null; metadata and screenshot_base64 are deliberately excluded.
 */
export function serializeInstanceHistoryLog(log: InstanceHistoryLogContent): string {
  return JSON.stringify({
    message: log.message ?? null,
    tool_args: log.tool_args ?? null,
    tool_result: log.tool_result ?? null,
    details: log.details ?? null,
  });
}

export interface InstanceHistoryMetadata {
  id: string;
  created_at: string;
  log_type: string;
  tool_name: string | null;
}

export interface InstanceHistoryListResult {
  action: 'list';
  logs: Array<InstanceHistoryMetadata & {
    preview: string;
    preview_is_partial: boolean;
    status: string | null;
    streaming: boolean;
  }>;
  next_cursor: InstanceHistoryCursor | null;
  has_more: boolean;
}

export interface InstanceHistoryReadResult extends InstanceHistoryMetadata {
  action: 'read';
  content: string;
  offset: number;
  next_offset: number | null;
  total_chars: number;
  is_partial: boolean;
  has_more: boolean;
}

export type InstanceHistoryResult = InstanceHistoryListResult | InstanceHistoryReadResult;
type HistoryRow = InstanceHistoryMetadata & InstanceHistoryLogContent;
type ListRow = HistoryRow & { status?: string | null; streaming?: string | null };
type ListArgs = Extract<z.output<typeof argsSchema>, { action: 'list' }>;
type ReadArgs = Extract<z.output<typeof argsSchema>, { action: 'read' }>;

// List never loads JSON payloads or screenshots. Read fetches ONE log's four
// content fields, not the instance transcript; slicing happens on the server.
const METADATA_COLUMNS = 'id,created_at,log_type,tool_name,message';
const LIST_COLUMNS = `${METADATA_COLUMNS},status:details->>status,streaming:details->>streaming`;
const READ_COLUMNS = `${METADATA_COLUMNS},tool_args,tool_result,details`;

function metadata(log: InstanceHistoryMetadata): InstanceHistoryMetadata {
  return {
    id: log.id,
    created_at: log.created_at,
    log_type: log.log_type.slice(0, INSTANCE_HISTORY_LIMITS.logTypeChars),
    tool_name: log.tool_name?.slice(0, INSTANCE_HISTORY_LIMITS.toolNameChars) ?? null,
  };
}

async function listHistory(siteId: string, instanceId: string, args: ListArgs): Promise<InstanceHistoryListResult> {
  let rows: ListRow[];
  try {
    let query = supabaseAdmin.from('instance_logs').select(LIST_COLUMNS)
      .eq('site_id', siteId).eq('instance_id', instanceId)
      .order('created_at', { ascending: false }).order('id', { ascending: false })
      .limit(args.limit + 1);
    if (args.query !== undefined) {
      if (args.query.includes('*')) {
        // PostgREST rewrites * to % even in escaped LIKE patterns. Use an
        // escaped literal regex for this case, never an executable user regex.
        query = query.filter('message', 'imatch', args.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      } else {
        query = query.ilike('message', `%${args.query.replace(/[\\%_]/g, '\\$&')}%`);
      }
    }
    if (args.log_type !== undefined) query = query.eq('log_type', args.log_type);
    if (args.before) {
      // Both interpolated values passed strict UUID/timestamp validation.
      const { created_at, id } = args.before;
      query = query.or(`created_at.lt.${created_at},and(created_at.eq.${created_at},id.lt.${id})`);
    }
    const { data, error } = await query;
    if (error) throw error;
    rows = (data ?? []) as ListRow[];
  } catch {
    // DB/network error messages can include query text or credentials.
    throw new Error('Unable to list instance history; retry later.');
  }

  const page = rows.slice(0, args.limit);
  const hasMore = rows.length > args.limit;
  const last = page[page.length - 1];
  return {
    action: 'list',
    logs: page.map(log => {
      const message = log.message ?? '';
      return {
        ...metadata(log),
        preview: message.slice(0, INSTANCE_HISTORY_LIMITS.previewChars),
        preview_is_partial: message.length > INSTANCE_HISTORY_LIMITS.previewChars,
        status: log.status?.slice(0, INSTANCE_HISTORY_LIMITS.statusChars) ?? null,
        streaming: log.streaming === 'true',
      };
    }),
    // Queued/streaming rows are intentionally included. Never derive a cursor
    // from a filtered preview list or skip the unread lookahead row.
    next_cursor: hasMore && last ? { created_at: last.created_at, id: last.id } : null,
    has_more: hasMore,
  };
}

async function readHistory(siteId: string, instanceId: string, args: ReadArgs): Promise<InstanceHistoryReadResult> {
  let row: HistoryRow | null;
  try {
    const { data, error } = await supabaseAdmin.from('instance_logs').select(READ_COLUMNS)
      .eq('site_id', siteId).eq('instance_id', instanceId).eq('id', args.log_id).maybeSingle();
    if (error) throw error;
    row = data as HistoryRow | null;
  } catch {
    throw new Error('Unable to read instance history; retry later.');
  }
  // Identical error for an absent row and one outside this trusted scope.
  if (!row) throw new Error('Instance history log not found in the current site and instance.');

  let serialized: string;
  try {
    serialized = serializeInstanceHistoryLog(row);
  } catch {
    throw new Error('Unable to serialize this instance history log.');
  }
  const content = serialized.slice(args.offset, args.offset + args.limit);
  const end = args.offset + content.length;
  const hasMore = end < serialized.length;
  return {
    action: 'read',
    ...metadata(row),
    content,
    offset: args.offset,
    next_offset: hasMore ? end : null,
    total_chars: serialized.length,
    is_partial: args.offset > 0 || hasMore,
    has_more: hasMore,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidArguments(error: z.ZodError, rawArgs: unknown): Error {
  const nested = isRecord(rawArgs) && Object.prototype.hasOwnProperty.call(rawArgs, 'request');
  const request = nested && isRecord(rawArgs) ? rawArgs.request : rawArgs;
  const action = isRecord(request) ? request.action : undefined;
  const wrongFields = action === 'read' ? ['query', 'log_type', 'before'] : action === 'list' ? ['log_id', 'offset'] : [];
  const wrong = wrongFields.filter(field => isRecord(request) && Object.prototype.hasOwnProperty.call(request, field));
  const problems: string[] = [];
  if (wrong.length) {
    // Names and examples come exclusively from this fixed allowlist, never
    // arbitrary unknown keys, values, identifiers, or Zod enum-value messages.
    const example = action === 'read'
      ? '"action":"read","log_id":"<log UUID from list>","offset":0,"limit":4000'
      : '"action":"list","query":null,"log_type":null,"before":null,"limit":10';
    problems.push(`action="${action}" does not allow ${action === 'read' ? 'list' : 'read'}-only fields: ${wrong.join(', ')}. Remove these fields; ${nested ? 'use' : 'model form'}: {"request":{${example}},"thought_process":""}`);
  }
  if (error.issues.some(issue => issue.code === 'unrecognized_keys' && (
    issue.path.join('.') !== (nested ? 'request' : '') ||
    issue.keys.some(key => !wrongFields.includes(key))
  ))) {
    problems.push('Unknown arguments are not allowed, including site/instance overrides');
  }
  const safePaths = new Set(['action', 'thought_process', 'query', 'log_type', 'before', 'before.created_at', 'before.id', 'log_id', 'offset', 'limit', 'request']);
  for (const issue of error.issues) {
    if (problems.length >= 3) break;
    if (issue.code === 'unrecognized_keys') continue;
    const path = issue.path.join('.').replace(/^request\./, '');
    const label = safePaths.has(path) ? path : 'arguments';
    const detail = issue.code === 'invalid_type' ? `Expected ${issue.expected}`
      : issue.code === 'invalid_enum_value' || issue.code === 'invalid_union_discriminator' ? 'Expected action "list" or "read"'
      : issue.code === 'too_small' ? `Must be at least ${issue.minimum}`
      : issue.code === 'too_big' ? `Must be at most ${issue.maximum}`
      : 'Invalid value or format';
    problems.push(`${label}: ${detail}`);
  }
  return new Error(`Invalid instance_history arguments: ${problems.join('; ') || 'Invalid value or format'}`);
}

/** Syntax only, not authorization. Catalog-only contexts have no history scope. */
export function hasInstanceHistoryScope(siteId: unknown, instanceId: unknown): boolean {
  return uuid.safeParse(siteId).success && uuid.safeParse(instanceId).success;
}

/** Server-side only. The caller must supply an already-authorized scope. */
export function createInstanceHistoryReader(siteId: string, instanceId: string) {
  if (!hasInstanceHistoryScope(siteId, instanceId)) {
    throw new Error('instance_history requires trusted siteId and instanceId UUIDs.');
  }
  return async (rawArgs: unknown): Promise<InstanceHistoryResult> => {
    let args = rawArgs;
    if (isRecord(rawArgs) && Object.prototype.hasOwnProperty.call(rawArgs, 'request')) {
      // Validate the entire envelope before normalizing documented null defaults.
      // Mixed flat/enveloped calls, extra fields and scope overrides fail closed.
      const model = instanceHistoryModelArgsSchema.safeParse(rawArgs);
      if (!model.success) throw invalidArguments(model.error, rawArgs);
      const request = model.data.request;
      args = request.action === 'list' ? {
        action: request.action, thought_process: model.data.thought_process,
        query: request.query ?? undefined, log_type: request.log_type ?? undefined,
        before: request.before ?? undefined, limit: request.limit ?? undefined,
      } : {
        action: request.action, thought_process: model.data.thought_process,
        log_id: request.log_id, offset: request.offset ?? undefined, limit: request.limit ?? undefined,
      };
    }
    const parsed = argsSchema.safeParse(args);
    if (!parsed.success) {
      throw invalidArguments(parsed.error, rawArgs);
    }
    return parsed.data.action === 'list'
      ? listHistory(siteId, instanceId, parsed.data)
      : readHistory(siteId, instanceId, parsed.data);
  };
}