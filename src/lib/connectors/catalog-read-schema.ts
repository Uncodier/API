import { unsupportedSchema, type CatalogReadMetadata } from './catalog-read-metadata';
import { hashConnectorSchema } from './composio-tool-json';
import type { PublishedList } from './catalog-read-published';
import { assertSupportedSchema } from './schema-validation';

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const annotations = ['description', 'title'];
const limitFields = ['limit', 'page_size', 'per_page', 'max_results', 'pageSize', 'perPage', 'maxResults'];
const pageFields = ['page', 'offset'];
export const MAX_CATALOG_ROWS = 25;

// This is deliberately a positive language, not an attempt to sanitize arbitrary JSON Schema.
// A page-size control is mandatory and always sent explicitly. No optional hidden selectors,
// properties/fields, search language, file loaders, expansion, or provider-controlled defaults.
export function catalogListSchema(raw: Record<string, unknown>) {
  if (raw.type !== 'object' || !record(raw.properties) || (raw.additionalProperties !== undefined && raw.additionalProperties !== false)
    || Object.keys(raw).some(k => !['type', 'properties', 'required', 'additionalProperties', ...annotations].includes(k))) unsupportedSchema();
  const keys = Object.keys(raw.properties);
  const [limit] = keys.filter(k => limitFields.includes(k));
  if (keys.length > 2 || keys.filter(k => limitFields.includes(k)).length !== 1 ||
    keys.some(k => k !== limit && !pageFields.includes(k))) unsupportedSchema();
  const required = raw.required === undefined ? [] : raw.required;
  if (!Array.isArray(required) || new Set(required).size !== required.length || required.some(k => !keys.includes(k))) unsupportedSchema();
  const properties: Record<string, { type: 'integer'; minimum: number; maximum: number }> = {};
  for (const key of keys) {
    let p = raw.properties[key];
    if (!record(p)) unsupportedSchema();
    const { default: def } = p;
    if (Object.keys(p).some(k => !['type', 'anyOf', 'minimum', 'maximum', 'default', ...annotations].includes(k))) unsupportedSchema();
    if (Object.hasOwn(p, 'anyOf')) {
      if (Object.keys(p).some(k => !['anyOf', 'default', ...annotations].includes(k)) || !Array.isArray(p.anyOf) || p.anyOf.length !== 2
        || !p.anyOf.some(v => record(v) && v.type === 'null' && Object.keys(v).length === 1)) unsupportedSchema();
      p = p.anyOf.find(v => record(v) && v.type === 'integer');
      if (!record(p) || Object.keys(p).some(k => !['type', 'minimum', 'maximum'].includes(k))) unsupportedSchema();
    }
    if (p.type !== 'integer' || [p.minimum, p.maximum].some(n => n !== undefined && !Number.isSafeInteger(n))) unsupportedSchema();
    const minimum = Math.max(key === 'offset' ? 0 : 1, Number(p.minimum ?? 0));
    const maximum = Math.min(key === limit ? MAX_CATALOG_ROWS : 100, Number(p.maximum ?? 100));
    if (maximum < minimum || (key !== limit && def != null && (!Number.isSafeInteger(def) || Number(def) < minimum || Number(def) > maximum))) unsupportedSchema();
    properties[key] = { type: 'integer', minimum, maximum };
  }
  const modelSchema = { type: 'object', properties, required: [...new Set([limit, ...required])], additionalProperties: false };
  assertSupportedSchema(modelSchema);
  return { modelSchema, limit };
}

// Independently confirm that the declared data is a single collection of ordinary summaries,
// not a stream, generic JSON payload, materialized document, credential or provider envelope.
// Optional annotations are discarded. Constraints not implemented here are not silently ignored.
export function catalogListOutput(raw: unknown, resource: string) {
  const props = (schema: unknown) => {
    if (!record(schema) || schema.type !== 'object' || !record(schema.properties) ||
      Object.keys(schema).some(k => !['type', 'properties', 'required', 'additionalProperties', ...annotations].includes(k)) ||
      (schema.additionalProperties !== undefined && schema.additionalProperties !== false)) unsupportedSchema();
    if (schema.required !== undefined && (!Array.isArray(schema.required) || new Set(schema.required).size !== schema.required.length ||
      schema.required.some(k => typeof k !== 'string' || !Object.hasOwn(schema.properties as object, k)))) unsupportedSchema();
    return schema.properties;
  };
  const wrapper = props(raw);
  const [key] = Object.keys(wrapper);
  if (Object.keys(wrapper).length !== 1 || ![resource, 'items', 'results'].includes(key)) unsupportedSchema();
  const list = wrapper[key];
  if (!record(list) || list.type !== 'array' || Object.keys(list).some(k => !['type', 'items', 'minItems', 'maxItems', ...annotations].includes(k)) ||
    [list.minItems, list.maxItems].some(n => n !== undefined && (!Number.isSafeInteger(n) || Number(n) < 0))) unsupportedSchema();
  const min = Number(list.minItems ?? 0); const max = Math.min(MAX_CATALOG_ROWS, Number(list.maxItems ?? MAX_CATALOG_ROWS));
  if (min > max) unsupportedSchema();
  const row = props(list.items);
  if (!Object.keys(row).length) unsupportedSchema();
  const fields: Record<string, 'string' | 'integer'> = {};
  for (const [field, s] of Object.entries(row)) {
    if (!record(s) || !['id', 'name', 'title'].includes(field) || (s.type !== 'string' && !(field === 'id' && s.type === 'integer')) ||
      Object.keys(s).some(k => !['type', ...annotations].includes(k))) unsupportedSchema();
    fields[field] = s.type as 'string' | 'integer';
  }
  return { collection: key, fields, min, max, required: ((list.items as Record<string, unknown>).required ?? []) as string[] };
}

// Only presentation annotations on a schema NODE can vary. Keys of properties and $defs
// are literal names (including "description"). Defaults, constraints and references are
// part of the fingerprint. Nothing follows, fetches or interprets a provider $ref.
function publishedShape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publishedShape);
  if (!record(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, child] of Object.entries(value)) {
    if (['title', 'description', 'examples', 'human_parameter_name', 'human_parameter_description'].includes(k)) continue;
    if ((k === 'properties' || k === '$defs') && record(child)) {
      out[k] = Object.fromEntries(Object.entries(child).map(([field, spec]) => [field, publishedShape(spec)]));
    } else if (['items', 'additionalProperties', 'anyOf'].includes(k)) {
      out[k] = publishedShape(child);
    } else {
      out[k] = child; // constraints/literal values are not annotation-bearing schema nodes
    }
  }
  return out;
}

export function publishedListSchema(tool: CatalogReadMetadata, profile: PublishedList) {
  if (!record(tool.output_parameters) || hashConnectorSchema({
    input_parameters: publishedShape(tool.input_parameters), output_parameters: publishedShape(tool.output_parameters),
  }) !== profile.shape) unsupportedSchema();
  // Published selectors, cursors, history and association graphs are not model inputs.
  // A server-owned request always sets the page size explicitly.
  return { type: 'object', properties: { [profile.limitField]: { type: 'integer', minimum: 1, maximum: MAX_CATALOG_ROWS } },
    required: [profile.limitField], additionalProperties: false };
}
