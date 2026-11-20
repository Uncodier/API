import { TABLE_TOOL } from './supabase-table-policy';
import { ConnectorError } from './types';
import { assertSupportedSchema, validateConnectorInput } from './schema-validation';

/** Public input contract reviewed 2026-11-19:
 * https://docs.composio.dev/toolkits/gmail.md
 * https://docs.composio.dev/toolkits/hubspot.md
 * https://docs.composio.dev/toolkits/supabase.md (table listing reviewed 2026-11-20)
 * These field/type ceilings supplement, never replace, the fetched versioned schema.
 */
const fields: Record<string, Record<string, string>> = {
  [TABLE_TOOL]: { project_ref: 'string', schemas: 'array', include_views: 'boolean', include_metadata: 'boolean', include_system_schemas: 'boolean' },
  GMAIL_FETCH_EMAILS: { query: 'string', verbose: 'boolean', ids_only: 'boolean', label_ids: 'array',
    page_token: 'string', max_results: 'integer', include_payload: 'boolean', include_spam_trash: 'boolean' },
  HUBSPOT_LIST_CONTACTS: { after: 'string', limit: 'integer', archived: 'boolean', properties: 'array',
    associations: 'array', propertiesWithHistory: 'array' },
};
const unsupported = () => new ConnectorError('SCHEMA_UNSUPPORTED', 'This tool schema requires an additional security review.', 409);

function hasReviewedType(schema: any, expected: string): boolean {
  if (!schema || typeof schema !== 'object') return false;
  if (schema.anyOf) return Array.isArray(schema.anyOf) && schema.anyOf.length <= 2 &&
    schema.anyOf.some((child: any) => hasReviewedType(child, expected)) &&
    schema.anyOf.every((child: any) => child.type === 'null' || hasReviewedType(child, expected));
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.includes(expected) || types.some((type: string) => type !== expected && type !== 'null')) return false;
  return expected !== 'array' || hasReviewedType(schema.items, 'string');
}

/** The hash is ALWAYS computed from the original descriptor, not this model projection. */
export function reviewedInputSchema(toolSlug: string, schema: unknown): Record<string, any> {
  const copy = JSON.parse(JSON.stringify(schema));
  if (!Object.hasOwn(fields, toolSlug) || copy?.type !== 'object' || !copy.properties || Array.isArray(copy.properties)) throw unsupported();
  if (toolSlug === 'GMAIL_FETCH_EMAILS' && Object.hasOwn(copy.properties, 'user_id')) {
    if (!hasReviewedType(copy.properties.user_id, 'string') || copy.properties.user_id.const !== undefined || copy.properties.user_id.enum !== undefined) throw unsupported();
    // Validate all constraints before removing the private mailbox selector.
    assertSupportedSchema(copy.properties.user_id);
    try { validateConnectorInput({ type: 'object', properties: { mailbox: copy.properties.user_id } }, { mailbox: 'me' }); }
    catch { throw unsupported(); }
    delete copy.properties.user_id;
    if (Array.isArray(copy.required)) copy.required = copy.required.filter((key: string) => key !== 'user_id');
  }
  for (const [key, value] of Object.entries(copy.properties)) {
    if (!Object.hasOwn(fields[toolSlug], key) || !hasReviewedType(value, fields[toolSlug][key])) throw unsupported();
  }
  if (toolSlug === TABLE_TOOL) {
    if (Object.keys(fields[TABLE_TOOL]).some(key => !Object.hasOwn(copy.properties, key))
      || copy.required?.length !== 1 || copy.required[0] !== 'project_ref' || copy.properties.project_ref.type !== 'string') throw unsupported();
    // Only remove this exact known constraint, already enforced on the private binding.
    if (['^[a-z]{20}$', '^[a-z]+$'].includes(copy.properties.project_ref.pattern)) delete copy.properties.project_ref.pattern;
    // An omitted schemas selector must not acquire a provider-specified schema list.
    if (copy.properties.schemas.default != null) throw unsupported();
    assertSupportedSchema(copy);
    return { type: 'object', properties: {}, additionalProperties: false };
  }
  assertSupportedSchema(copy);
  return copy;
}

/** Additional public operation limits, independent of provider defaults. */
export function assertReviewedInputLimits(toolSlug: string, input: Record<string, unknown>): void {
  if (toolSlug === 'GMAIL_FETCH_EMAILS' && typeof input.max_results === 'number' &&
    (input.max_results < 1 || input.max_results > 500)) {
    throw new ConnectorError('INVALID_TOOL_ARGUMENTS', 'Gmail max_results must be between 1 and 500.', 400);
  }
}
/** Validate *injected* arguments against all remaining reviewed provider constraints. */
export function validateTableDispatchSchema(schema: Record<string, unknown>, args: Record<string, unknown>) {
  reviewedInputSchema(TABLE_TOOL, schema);
  const copy = JSON.parse(JSON.stringify(schema));
  delete copy.properties.project_ref.pattern; // Only the exact locally enforced pattern was accepted above.
  validateConnectorInput(copy, args);
}
