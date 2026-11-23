import { validateJson } from './composio-transport';
import { assertDirectArguments, isDirectStringFormat, safeDirectPattern } from './provider-direct-validation';
import { CONNECTOR_MAX_ARRAY_ITEMS, CONNECTOR_MAX_STRING_UNITS } from './public-input-schema';
import { directFieldSafe, unsupportedDirectSchema } from './provider-direct-guards';
import { ConnectorError } from './types';

type Dict = Record<string, unknown>;
const obj = (v: unknown): v is Dict => !!v && typeof v === 'object' && !Array.isArray(v);
const allowedTypes = ['string', 'number', 'integer', 'boolean', 'null', 'object', 'array'];
const labels = ['description', 'title', 'human_parameter_name', 'human_parameter_description'];
const presentation = [...labels, 'examples'];
const safeVocabulary = (v: unknown) => v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) ||
  (typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,47}$/.test(v) && !/[^A-Za-z0-9_.-]/.test(v));

// Do not use JSON.stringify on the caller's objects: inherited array/toJSON hooks,
// sparse arrays or accessors must never produce a different wire object than was checked.
export function snapshotDirectJson(value: unknown): unknown {
  validateJson(value, 16);
  let left = 64_000;
  const visit = (v: unknown): unknown => {
    if ((left -= typeof v === 'string' ? Buffer.byteLength(v) + 2 : 1) < 0) invalid();
    if (v === null || typeof v !== 'object') return v;
    const keys = Reflect.ownKeys(v);
    if (Array.isArray(v)) {
      if (Object.getPrototypeOf(v) !== Array.prototype || v.length > 512 || keys.length !== v.length + 1) invalid();
      return Array.from({ length: v.length }, (_, index) => visit(property(v, String(index))));
    }
    const out: Dict = Object.create(null);
    for (const key of keys) {
      if (typeof key !== 'string' || key.length > 100 || (left -= key.length + 3) < 0) invalid();
      out[key] = visit(property(v, key));
    }
    return out;
  };
  return visit(value);
}
function property(v: object, key: string) {
  const d = Object.getOwnPropertyDescriptor(v, key);
  if (!d?.enumerable || !('value' in d) || key === 'toJSON') invalid();
  return d.value;
}
function invalid(): never { throw new ConnectorError('CONNECTOR_INVALID_INPUT', 'Expected a bounded JSON request.', 400); }

// Fingerprint the provider contract, not its display copy. Descend only through
// known schema positions: property/definition names and literal values (notably
// defaults and enum members) can themselves contain keys named 'description'.
// Unrecognized keywords stay in the pin verbatim. Never resolve references here.
export function directSchemaContract(schema: Dict): Dict {
  const node = (v: unknown): unknown => obj(v) ? directSchemaContract(v) : v;
  const out: Dict = Object.create(null);
  for (const [key, value] of Object.entries(schema)) {
    if (presentation.includes(key)) continue;
    if (['properties', '$defs', 'definitions', 'patternProperties', 'dependentSchemas'].includes(key) && obj(value)) {
      out[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, node(child)]));
    } else if (['items', 'anyOf', 'oneOf', 'allOf', 'prefixItems'].includes(key) && Array.isArray(value)) {
      out[key] = value.map(node);
    } else if (['items', 'additionalProperties'].includes(key)) {
      out[key] = node(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

// Fail closed on unimplemented semantic keywords; never publish provider prose, examples,
// or dynamic property names. Omitted additionalProperties is locally narrowed to false.
export function directParameterPlan(raw: unknown, projectRef?: string) {
  validateJson(raw);
  const injected: Dict = {};
  const annotations = [...presentation, 'default'];
  let nodes = 0;
  function project(v: unknown, depth: number): Dict {
    if (!obj(v) || ++nodes > 400 || depth > 10) unsupportedDirectSchema();
    if (v.$ref !== undefined) {
      // Bounded expansion of local child definitions only. No remote documents,
      // filesystem/URL resolution, arbitrary JSON pointers, ignored siblings or cycles.
      const m = typeof v.$ref === 'string' && /^#\/(\$defs|definitions)\/([A-Za-z][A-Za-z0-9_]{0,63})$/.exec(v.$ref);
      if (!m || m[0]!==v.$ref || !obj(raw) || Object.keys(v).some(k => k !== '$ref' && !presentation.includes(k))) unsupportedDirectSchema();
      const defs = raw[m[1]];
      if (!obj(defs) || !Object.hasOwn(defs,m[2])) unsupportedDirectSchema();
      return project(defs[m[2]],depth+1);
    }
    let out: Dict;
    if (v.anyOf !== undefined) {
      if (Object.keys(v).some(k => ![...annotations, 'anyOf'].includes(k)) || !Array.isArray(v.anyOf) ||
        !v.anyOf.length || v.anyOf.length > 8) unsupportedDirectSchema();
      out = { anyOf: v.anyOf.map(child => project(child, depth + 1)) };
    } else {
      const types = Array.isArray(v.type) ? v.type : [v.type];
      if (!types.length || types.length > 7 || new Set(types).size !== types.length ||
        !types.every(t => typeof t === 'string' && allowedTypes.includes(t))) unsupportedDirectSchema();
      out = { type: v.type };
      const keys = new Set([...annotations, 'type', 'enum', 'const']);
      for (const key of ['$defs','definitions']) if (depth===0 && v[key]!==undefined) { if (!obj(v[key])) unsupportedDirectSchema(); keys.add(key); }
      if (types.includes('object')) {
        for (const k of ['properties', 'required', 'additionalProperties']) keys.add(k);
        const props = v.properties===undefined && v.additionalProperties===false ? {} : v.properties;
        if (!obj(props) || Object.keys(props).length > 100 ||
          (v.additionalProperties !== undefined && v.additionalProperties !== false)) unsupportedDirectSchema();
        if (v.required !== undefined) {
          if (!Array.isArray(v.required) || new Set(v.required).size !== v.required.length ||
            !v.required.every(name => typeof name === 'string' && Object.hasOwn(props, name))) unsupportedDirectSchema();
          out.required = [...v.required];
        }
        const fields: Dict = Object.create(null);
        for (const [name, child] of Object.entries(props)) {
          if (!directFieldSafe(name)) {
            if (!obj(child)) unsupportedDirectSchema();
            // A bound-project action must never depend on an unknown default project.
            if (depth === 0 && name === 'project_ref' && !projectRef) unsupportedDirectSchema();
            const self = depth === 0 && (name === 'user_id' || name === 'mailbox') &&
              (child.default === 'me' || child.const === 'me');
            const bound = depth === 0 && (name === 'project_ref' || name === 'ref') && projectRef !== undefined;
            if (self || bound) {
              const value = self ? 'me' : projectRef;
              const constraint = project(child,depth+1);
              try { assertDirectArguments({type:'object',properties:{value:constraint}}, {value}); }
              catch {unsupportedDirectSchema();}
              injected[name] = value;
              if (Array.isArray(out.required)) out.required = out.required.filter(k => k !== name);
            } else if ((Array.isArray(v.required) && v.required.includes(name)) ||
              (child.default != null && !(projectRef && child.type==='boolean' && child.default===false)) ||
              Object.keys(child).some(k=>!['type','items','properties','additionalProperties','required',...annotations].includes(k))) {
              // Unknown omission behavior (e.g. a $ref or a provider default) is
              // not a verified account selector. Never silently switch accounts.
              unsupportedDirectSchema();
            }
            // Omit optional fetch/credential/selector fields with no declared default.
            continue;
          }
          fields[name] = project(child,depth+1);
        }
        out.properties = fields;
        out.additionalProperties = false;
      }
      const bounds = (min: string, max: string, cap?: number) => {
        keys.add(min); keys.add(max);
        for (const k of [min, max]) if (v[k] !== undefined) {
          const n = v[k];
          if (typeof n !== 'number' || !Number.isFinite(n) || (cap !== undefined && (!Number.isSafeInteger(n) || n < 0))) unsupportedDirectSchema();
          out[k] = n;
        }
        if (cap !== undefined) out[max] = Math.min((out[max] as number | undefined) ?? cap, cap);
        if (typeof out[min] === 'number' && typeof out[max] === 'number' && out[min] > out[max]) unsupportedDirectSchema();
      }
      if (types.includes('array')) { keys.add('items'); out.items = project(v.items, depth + 1); bounds('minItems', 'maxItems', CONNECTOR_MAX_ARRAY_ITEMS); }
      if (types.includes('string')) {
        bounds('minLength', 'maxLength', CONNECTOR_MAX_STRING_UNITS);
        if (v.format!==undefined) { if (!isDirectStringFormat(v.format)) unsupportedDirectSchema(); keys.add('format'); out.format=v.format; }
        if (v.pattern !== undefined) { if (!safeDirectPattern(v.pattern)) unsupportedDirectSchema(); keys.add('pattern'); out.pattern = v.pattern; }
      }
      if (types.includes('number') || types.includes('integer')) bounds('minimum', 'maximum');
      if (Object.keys(v).some(k => !keys.has(k))) unsupportedDirectSchema();
      if (v.enum !== undefined) {
        if (!Array.isArray(v.enum) || !v.enum.length || v.enum.length > 64 || !v.enum.every(safeVocabulary)) unsupportedDirectSchema();
        out.enum = v.enum.slice();
      }
      if ('const' in v) { if (!safeVocabulary(v.const)) unsupportedDirectSchema(); out.const = v.const; }
    }
    // Defaults may affect an omission at the provider. Verify them even though the
    // dispatcher never supplies defaults or echoes their contents in the descriptor.
    if (v.default !== undefined && v.default !== null) {
      try { assertDirectArguments({type:'object', properties:{value:out}}, {value:v.default}); }
      catch { unsupportedDirectSchema(); }
    }
    return out;
  }
  if (!obj(raw) || raw.type !== 'object') unsupportedDirectSchema();
  const out = project(raw, 0);
  return {parameters:out,injected};
}
