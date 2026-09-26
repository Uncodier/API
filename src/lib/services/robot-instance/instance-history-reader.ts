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

const argsSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('list'),
    thought_process: thoughtProcess,
    query: z.string().min(1).max(INSTANCE_HISTORY_LIMITS.queryChars)
      .refine(value => value.trim().length > 0 && !value.includes('\0'), 'Use a non-empty query without NUL characters')
      .optional(),
    log_type: z.string().min(1).max(INSTANCE_HISTORY_LIMITS.logTypeChars)
      .refine(value => value.trim().length > 0 && !value.includes('\0'), 'Use a non-empty log_type without NUL characters')
      .optional(),
    before: cursorSchema.optional(),
    limit: safeInteger.min(1).max(INSTANCE_HISTORY_LIMITS.list).default(INSTANCE_HISTORY_DEFAULTS.list),
  }).strict(),
  z.object({
    action: z.literal('read'),
    thought_process: thoughtProcess,
    log_id: uuid,
    offset: safeInteger.default(0),
    limit: safeInteger.min(1).max(INSTANCE_HISTORY_LIMITS.readChars).default(INSTANCE_HISTORY_DEFAULTS.readChars),
  }).strict(),
]);

export type InstanceHistoryArgs = z.input<typeof argsSchema>;
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

/** Server-side only. The caller must supply an already-authorized scope. */
export function createInstanceHistoryReader(siteId: string, instanceId: string) {
  if (!uuid.safeParse(siteId).success || !uuid.safeParse(instanceId).success) {
    throw new Error('instance_history requires trusted siteId and instanceId UUIDs.');
  }
  return async (rawArgs: unknown): Promise<InstanceHistoryResult> => {
    const parsed = argsSchema.safeParse(rawArgs);
    if (!parsed.success) {
      const problems = parsed.error.issues.slice(0, 3).map(issue =>
        issue.code === 'unrecognized_keys'
          ? 'Unknown arguments are not allowed, including site/instance overrides'
          : `${issue.path.join('.') || 'arguments'}: ${issue.message}`);
      throw new Error(`Invalid instance_history arguments: ${problems.join('; ')}`);
    }
    return parsed.data.action === 'list'
      ? listHistory(siteId, instanceId, parsed.data)
      : readHistory(siteId, instanceId, parsed.data);
  };
}