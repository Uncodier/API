import { z } from 'zod';
import { unsupportedAction, unsupportedSchema, unsupportedScopes, type CatalogReadMetadata } from './catalog-read-metadata';
import { isBoundSupabaseProject } from './supabase-table-policy';
import { ConnectorError, type Connector } from './types';

// https://docs.composio.dev/toolkits/supabase — not the SQL, PostgREST or service-role tools.
export const SUPABASE_CATALOG_SLUG = 'SUPABASE_RUN_READ_ONLY_QUERY';
export const REPORT_SCOPE = 'database_read';
const version = '20261116_00';
const tags = ['important', 'readOnlyHint', 'openWorldHint', 'Database'];
const annotations = { title: z.string().optional(), description: z.string().optional() };
const ref = z.object({ ...annotations, type: z.literal('string'), pattern: z.enum(['^[a-z]+$', '^[a-z]{20}$']).optional(),
  minLength: z.literal(20).optional(), maxLength: z.literal(20).optional(), examples: z.array(z.string().length(20).regex(/^[a-z]{20}$/)).optional() }).strict();
const stringSchema = z.object({ ...annotations, type: z.literal('string') }).strict();
const querySchema = stringSchema.extend({ minLength: z.literal(1).optional(), examples: z.array(z.string().max(4096)).max(20).optional() }).strict();
const nil = z.object({ type: z.literal('null') }).strict();
// Validate documented primitive alternatives without exposing this field to the caller.
// We generate every bind parameter on the server as a string; arbitrary nested schema is not allowed.
const primitive = z.object({ type:z.enum(['string','integer','number','boolean','null']) }).strict();
const parameterItems = z.object({ anyOf:z.array(primitive).min(1).max(5).refine(list =>
  list.some(item=>item.type==='string') && new Set(list.map(item=>item.type)).size===list.length) }).strict();
const sample = z.union([z.string().max(1024),z.number(),z.boolean(),z.null()]);
const arraySchema = z.object({ ...annotations, type: z.literal('array'),
  examples:z.array(z.union([z.null(),z.array(sample).max(20)])).max(20).optional(),
  items: z.union([z.object({}).strict(), stringSchema, parameterItems]) }).strict();
const parameters = z.union([arraySchema, z.object({ ...annotations, default: z.null().optional(),
  anyOf: z.union([z.tuple([arraySchema, nil]), z.tuple([nil, arraySchema])]) }).strict()]);
const providerInput = z.object({ ...annotations, type: z.literal('object'), additionalProperties: z.literal(false).optional(),
  properties: z.object({ ref, query: querySchema, parameters }).strict(),
  required: z.union([z.tuple([z.literal('ref'), z.literal('query')]), z.tuple([z.literal('query'), z.literal('ref')])]),
}).strict();

export function assertReportContract(tool: CatalogReadMetadata) {
  if (tool.slug !== SUPABASE_CATALOG_SLUG || tool.toolkit.slug !== 'supabase' || tool.version !== version ||
    tool.no_auth !== false || tool.is_deprecated !== false || tool.deprecated?.is_deprecated ||
    !Array.isArray(tool.tags) || tool.tags.length !== tags.length || !tags.every(tag => (tool.tags as unknown[]).includes(tag))) unsupportedAction();
  if (tool.scope_requirements !== null || tool.scopes.length !== 1 || tool.scopes[0] !== REPORT_SCOPE) unsupportedScopes();
  if (!providerInput.safeParse(tool.input_parameters).success) unsupportedSchema();
}

export const DEFAULT_REPORT_LIMIT = 10;
export const MAX_REPORT_LIMIT = 25;
export function reportModelSchema() {
  return { type: 'object', additionalProperties: false, properties: {
    view: { type: 'string', minLength: 1, maxLength: 48, description: 'Omit to list published reports. To read one, supply its exact lowercase report name from that list.' },
    after: { type: 'string', minLength: 1, maxLength: 48, description: 'When listing report names only, pass next_after from the previous page. Omit on the first page.' },
    limit: { type: 'integer', minimum: 1, maximum: MAX_REPORT_LIMIT, default: DEFAULT_REPORT_LIMIT,
      description: 'Maximum report names or rows to return. This is a bounded sample, not a complete inventory.' },
  } };
}

// Shared by the SQL inventory predicate and the model-input/output validator (portable POSIX/JS syntax).
export const REPORT_NAME_SHAPE = '^[a-z][a-z0-9_]{0,47}$';
export const REPORT_NAME_EXCLUSIONS = '^pg_|__|sbp_|sb_secret_|sk_live|gh[pousr]_|password|credential|secret|api_?key|token|authorization|constructor|prototype|[a-z0-9]{24,}';
const nameShape = new RegExp(REPORT_NAME_SHAPE);
const excluded = new RegExp(REPORT_NAME_EXCLUSIONS);
export function reportViewId(v: unknown): v is string {
  return typeof v === 'string' && nameShape.test(v) && !/[^a-z0-9_]/.test(v) && !excluded.test(v);
}

export function reportRequest(args: Record<string, unknown>) {
  const view = Object.hasOwn(args, 'view') ? args.view : undefined;
  const after = Object.hasOwn(args, 'after') ? args.after : undefined;
  const limit = Object.hasOwn(args, 'limit') ? args.limit : DEFAULT_REPORT_LIMIT;
  if (Object.keys(args).some(k => !['view', 'limit', 'after'].includes(k)) ||
    (Object.hasOwn(args, 'after') && (view !== undefined || !reportViewId(after))) ||
    (Object.hasOwn(args, 'view') && !reportViewId(view)) || typeof limit !== 'number' ||
    !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_REPORT_LIMIT) {
    throw new ConnectorError('INVALID_TOOL_ARGUMENTS', 'List reports with an optional next_after value as after, or read one exact view. Use a limit between 1 and 25.', 400);
  }
  return { view: view as string | undefined, after: after as string | undefined, limit };
}

export function reportBinding(connector: Connector) {
  const site = connector.site_id;
  if (!isBoundSupabaseProject(connector) || typeof site !== 'string' || site.length !== 36 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(site)) {
    throw new ConnectorError('CONNECTOR_PROJECT_UNBOUND', 'Bind this site to its verified Supabase project before using published reports.', 409);
  }
  return { profile: 'postgres-owned-label-value-view-v2', ref: connector.supabase_project_ref!, schema: `makinari_reports_${site.replace(/-/g, '')}` };
}
