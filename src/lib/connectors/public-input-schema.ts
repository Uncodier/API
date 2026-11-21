import { ConnectorError } from './types';

export const CONNECTOR_MAX_STRING_UNITS = 8000;
export const CONNECTOR_MAX_ARRAY_ITEMS = 100;
export const GMAIL_COUNT_RANGE = { minimum: 1, maximum: 500 } as const;

type Schema = Record<string, any>;
type Range = { minimum: number; maximum: number };
type Source = 'reviewed' | 'catalog';
const unitLimit = `At most ${CONNECTOR_MAX_STRING_UNITS} UTF-16 code units.`;
const unsupported = () => new ConnectorError('SCHEMA_UNSUPPORTED', 'This tool schema requires an additional security review.', 409);
const scalar = (v: unknown) => v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));

/** Only after assertSupportedSchema AND field-level review or construction of a server-owned
 * catalogue projection. Never use catalogue mode on raw provider metadata. Only schema nodes
 * are traversed, not examples or arbitrary annotations. The original and its pin are unchanged. */
export function publicConnectorInputSchema(schema: Schema, source: Source, count?: { field: string; range: Range }): Schema {
  function project(node: Schema, range?: Range, root = false): Schema {
    const out: Schema = {};
    const types = Array.isArray(node.type) ? node.type : [node.type];
    if (node.type !== undefined) out.type = Array.isArray(node.type) ? [...node.type] : node.type;
    for (const key of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems']) {
      if (node[key] !== undefined) out[key] = node[key];
    }
    if (node.anyOf) out.anyOf = node.anyOf.map((child: Schema) => project(child, range));
    if (source === 'catalog' && typeof node.description === 'string') out.description = node.description;
    if (Object.hasOwn(node, 'default')) {
      if (source === 'catalog') out.default = structuredClone(node.default);
      // Defaults are annotations, not permission to add missing arguments. Never echo
      // arbitrary text/objects from reviewed provider metadata as the caller's default.
      else if (scalar(node.default)) out.default = node.default;
    }
    // An enum/const is an active constraint, never a source of additional field names or
    // prose. Reject unreviewed text/structured literals instead of publishing or ignoring them.
    if (node.enum !== undefined) {
      if (source === 'reviewed' && !node.enum.every(scalar)) throw unsupported();
      out.enum = structuredClone(node.enum);
    }
    if (Object.hasOwn(node, 'const')) {
      if (source === 'reviewed' && !scalar(node.const)) throw unsupported();
      out.const = structuredClone(node.const);
    }
    if (types.includes('object')) {
      out.additionalProperties = false;
      if (node.required !== undefined) out.required = [...node.required];
      out.properties = Object.fromEntries(Object.entries(node.properties).map(([key, child]) =>
        [key, project(child as Schema, root && count?.field === key ? count.range : undefined)]));
    }
    if (types.includes('array')) {
      out.maxItems = Math.min(node.maxItems ?? CONNECTOR_MAX_ARRAY_ITEMS, CONNECTOR_MAX_ARRAY_ITEMS);
      out.items = project(node.items);
    }
    // No redundant cap on a finite local vocabulary (e.g. workspace/platform).
    const literals = Object.hasOwn(node, 'const') ? [node.const] : node.enum as unknown[] | undefined;
    if (types.includes('string') && !literals?.every(v => typeof v !== 'string' || v.length <= CONNECTOR_MAX_STRING_UNITS)) {
      out.maxLength = Math.min(node.maxLength ?? CONNECTOR_MAX_STRING_UNITS, CONNECTOR_MAX_STRING_UNITS);
      // JSON Schema measures code points, while the transport guard measures UTF-16 code units.
      if (out.maxLength * 2 > CONNECTOR_MAX_STRING_UNITS && !out.description?.includes(unitLimit)) {
        out.description = [out.description, unitLimit].filter(Boolean).join(' ');
      }
    }
    if (range && types.includes('integer')) {
      out.minimum = Math.max(node.minimum ?? range.minimum, range.minimum);
      out.maximum = Math.min(node.maximum ?? range.maximum, range.maximum);
    }
    return out;
  }
  return project(schema, undefined, true);
}
