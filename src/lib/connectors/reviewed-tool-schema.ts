import { TABLE_TOOL } from './supabase-table-policy';
import { publicConnectorInputSchema, GMAIL_COUNT_RANGE } from './public-input-schema';
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
  if (schema.anyOf) {
    if (!Array.isArray(schema.anyOf) || schema.anyOf.length > 2 ||
      !schema.anyOf.some((child: any) => hasReviewedType(child, expected)) ||
      !schema.anyOf.every((child: any) => child?.type === 'null' || hasReviewedType(child, expected))) return false;
    if (schema.type === undefined) return true;
    // A typed sibling is also a constraint, not an alternate place to publish unreviewed properties.
  }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.includes(expected) || types.some((type: string) => type !== expected && type !== 'null')) return false;
  return expected !== 'array' || hasReviewedType(schema.items, 'string');
}

/** The hash is ALWAYS computed from the original descriptor, not this model projection. */
export function reviewedInputSchema(toolSlug: string, schema: unknown): Record<string, any> {
  const copy = JSON.parse(JSON.stringify(schema));
  // These reviewed roots are flat. Object-wide alternatives/literals could reintroduce a
  // private selector or expose a second, unreviewed set of property names after projection.
  if (!Object.hasOwn(fields, toolSlug) || copy?.type !== 'object' || !copy.properties || Array.isArray(copy.properties) ||
    copy.anyOf !== undefined || copy.enum !== undefined || Object.hasOwn(copy, 'const')) throw unsupported();
  if (toolSlug === 'GMAIL_FETCH_EMAILS' && Object.hasOwn(copy.properties, 'user_id')) {
    // Validate all constraints before removing the private mailbox selector.
    assertSupportedSchema(copy.properties.user_id);
    if (!hasReviewedType(copy.properties.user_id, 'string') || copy.properties.user_id.const !== undefined || copy.properties.user_id.enum !== undefined) throw unsupported();
    try { validateConnectorInput({ type: 'object', properties: { mailbox: copy.properties.user_id } }, { mailbox: 'me' }); }
    catch { throw unsupported(); }
    delete copy.properties.user_id;
    if (Array.isArray(copy.required)) copy.required = copy.required.filter((key: string) => key !== 'user_id');
  }
  if (toolSlug !== TABLE_TOOL) assertSupportedSchema(copy);
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
  const hasCount = toolSlug === 'GMAIL_FETCH_EMAILS' && Object.hasOwn(copy.properties, 'max_results');
  const model = publicConnectorInputSchema(copy, 'reviewed', hasCount ? { field: 'max_results', range: GMAIL_COUNT_RANGE } : undefined);
  if (hasCount) {
    // Don't advertise a count constraint the local range makes impossible. In particular
    // a nullable alternative or an omitted provider default is not proof of a safe count.
    const schema = {type:'object', properties:{count:model.properties.max_results}, required:['count']};
    let possible = false;
    for (let count=GMAIL_COUNT_RANGE.minimum; count<=GMAIL_COUNT_RANGE.maximum; count++) {
      try { validateConnectorInput(schema, {count}); possible=true; break; }
      catch (error) { if (!(error instanceof ConnectorError) || error.code!=='INVALID_TOOL_ARGUMENTS') throw error; }
    }
    if (!possible) throw unsupported();
  }
  if (hasCount && Object.hasOwn(copy.properties.max_results, 'default')) {
    // Omission is sent unchanged. Do not let a known nonconforming provider default bypass
    // the range or rewrite the arguments of a retained approval. Require an explicit value instead.
    const field = model.properties.max_results;
    try { validateConnectorInput({ type: 'object', properties: { max_results: field } }, { max_results: copy.properties.max_results.default }); }
    catch {
      delete field.default;
      if (!model.required?.includes('max_results')) model.required = [...(model.required ?? []), 'max_results'];
    }
  }
  return model;
}

/** Additional public operation limits, independent of provider defaults. */
export function assertReviewedInputLimits(toolSlug: string, input: Record<string, unknown>): void {
  if (toolSlug === 'GMAIL_FETCH_EMAILS' && typeof input.max_results === 'number' &&
    (input.max_results < GMAIL_COUNT_RANGE.minimum || input.max_results > GMAIL_COUNT_RANGE.maximum)) {
    throw new ConnectorError('INVALID_TOOL_ARGUMENTS', 'Gmail max_results must be between 1 and 500.', 400);
  }
}
/** Validate *injected* arguments against all remaining reviewed provider constraints. */
export function validateTableDispatchSchema(schema: Record<string, unknown>, args: Record<string, unknown>) {
  reviewedInputSchema(TABLE_TOOL, schema);
  const copy = JSON.parse(JSON.stringify(schema));
  delete copy.properties.project_ref.pattern; // Only the exact locally enforced pattern was accepted above.
  // Every argument here is injected by the server. A mismatch is schema drift, never a
  // caller-correctable input issue (including its path, bound project or provider literals).
  try { validateConnectorInput(copy, args); } catch { throw unsupported(); }
}
