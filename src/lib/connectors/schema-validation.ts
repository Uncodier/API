import { ConnectorError } from './types';

type Schema = Record<string, any>;
const supported = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum',
  'const', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'description',
  'title', 'default', 'examples', '$schema', 'anyOf']);
const forbiddenKey = /^(?:__proto__|prototype|constructor|site_id|siteId|user_id|userId|agentId|host|connected_account_id|account_id|api_key|authorization|custom_auth_params|custom_connection_data|version|text)$|(?:^|_)(?:file|files|filepath|path|url|uri|attachments?)(?:$|_)/i;
const unsupported = () => new ConnectorError('SCHEMA_UNSUPPORTED', 'This tool schema requires an additional security review.', 409);
const invalid = () => new ConnectorError('INVALID_TOOL_ARGUMENTS', 'Arguments do not match the described connector schema.', 400);

/** Reject unsupported constraints, rather than claiming validation while ignoring them. */
export function assertSupportedSchema(schema: unknown, depth = 0): asserts schema is Schema {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || depth > 12) throw unsupported();
  const value = schema as Schema;
  if (Object.keys(value).some(key => !supported.has(key))) throw unsupported();
  const types = Array.isArray(value.type) ? value.type : [value.type];
  if (value.anyOf !== undefined) {
    if (!Array.isArray(value.anyOf) || !value.anyOf.length || value.anyOf.length > 8) throw unsupported();
    // Without a type, sibling validation keywords would otherwise be ignored.
    if (value.type === undefined && Object.keys(value).some(key => !['anyOf', 'description', 'title', 'default', 'examples', '$schema'].includes(key))) throw unsupported();
    for (const child of value.anyOf) assertSupportedSchema(child, depth + 1);
  }
  if ((!value.anyOf || value.type !== undefined) && (!types.length ||
    types.some(type => !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(type)))) throw unsupported();
  if (value.enum !== undefined && (!Array.isArray(value.enum) || !value.enum.length)) throw unsupported();
  for (const key of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems']) {
    if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key]))) throw unsupported();
  }
  if (types.includes('object')) {
    if (!value.properties || typeof value.properties !== 'object' || Array.isArray(value.properties)) throw unsupported();
    if (value.additionalProperties !== undefined && value.additionalProperties !== false) throw unsupported();
    if (value.required !== undefined && (!Array.isArray(value.required) ||
      value.required.some((key: unknown) => typeof key !== 'string' || !Object.hasOwn(value.properties, key)))) throw unsupported();
    for (const [key, child] of Object.entries(value.properties)) {
      if (forbiddenKey.test(key)) throw unsupported();
      assertSupportedSchema(child, depth + 1);
    }
  }
  if (types.includes('array')) assertSupportedSchema(value.items, depth + 1);
}

function validate(schema: Schema, value: any, depth: number): void {
  if (depth > 12) throw invalid();
  if (schema.anyOf) {
    if (!schema.anyOf.some((child: Schema) => { try { validate(child, value, depth + 1); return true; } catch { return false; } })) throw invalid();
    if (schema.type === undefined) return;
  }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (!types.includes(actual) && !(actual === 'number' && types.includes('integer') && Number.isInteger(value))) throw invalid();
  if (schema.enum && !schema.enum.some((candidate: unknown) => JSON.stringify(candidate) === JSON.stringify(value))) throw invalid();
  if (Object.hasOwn(schema, 'const') && JSON.stringify(schema.const) !== JSON.stringify(value)) throw invalid();
  if (actual === 'number' && (!Number.isFinite(value) ||
    (schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum))) throw invalid();
  if (actual === 'string') {
    // No implicit downloads, local paths, or outbound fetch targets in this reviewed slice.
    if (value.length > 8000 || /(?:https?:\/\/|file:|\.{2}[\\/]|^\/|^[a-z]:\\)/i.test(value) ||
      (schema.minLength !== undefined && [...value].length < schema.minLength) ||
      (schema.maxLength !== undefined && [...value].length > schema.maxLength)) throw invalid();
  }
  if (actual === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw invalid();
    for (const required of schema.required ?? []) if (!Object.hasOwn(value, required)) throw invalid();
    for (const [key, child] of Object.entries(value)) {
      if (forbiddenKey.test(key) || !Object.hasOwn(schema.properties, key)) throw invalid();
      validate(schema.properties[key], child, depth + 1);
    }
  }
  if (actual === 'array') {
    if (value.length > 100 || (schema.minItems !== undefined && value.length < schema.minItems) ||
      (schema.maxItems !== undefined && value.length > schema.maxItems)) throw invalid();
    for (const item of value) validate(schema.items, item, depth + 1);
  }
}

export function validateConnectorInput(schema: unknown, input: unknown): asserts input is Record<string, unknown> {
  assertSupportedSchema(schema);
  if (!input || typeof input !== 'object' || Array.isArray(input) || JSON.stringify(input).length > 32000) throw invalid();
  validate(schema, input, 0);
}