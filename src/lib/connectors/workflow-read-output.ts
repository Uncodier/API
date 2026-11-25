import { validateJson } from './composio-transport';
import { directParameterPlan, directSchemaContract } from './provider-direct-schema';
import { assertDirectArguments } from './provider-direct-validation';
import { denied } from './workflow-read-binding';

type Dict = Record<string, unknown>;
const record = (v: unknown): v is Dict => v !== null && typeof v === 'object' && !Array.isArray(v);
export const MAX_WORKFLOW_ITEMS = 25;
type Check = (value: unknown) => void;

/** Compile a deliberately small output dialect. Unlike arguments, output records can
 * contain private keys; validate them before redaction. Never resolve external references. */
export function workflowOutputContract(raw: Dict | null | undefined, pageField?: string) {
  const schema = raw && directSchemaContract(raw);
  let nodes = 0;
  let envelope = false;
  function compile(node: unknown, depth: number, root = false): Check {
    if (!record(node) || ++nodes > 400 || depth > 10) denied();
    const keys = Object.keys(node).filter(k => k !== 'default' && !(depth === 0 && ['$defs','definitions'].includes(k) && record(node[k])));
    const only = (...supported: string[]) => { if (keys.some(k => !supported.includes(k))) denied(); };
    if ('$ref' in node) {
      only('$ref');
      const m = typeof node.$ref === 'string' && /^#\/(\$defs|definitions)\/([A-Za-z][A-Za-z0-9_]{0,63})$/.exec(node.$ref);
      const defs = m && schema?.[m[1]];
      if (!m || m[0] !== node.$ref || !record(defs) || !Object.hasOwn(defs,m[2])) denied();
      return compile(defs[m[2]],depth+1,root);
    }
    if (node.type === 'object') {
      only('type','properties','required','additionalProperties');
      const props = node.properties === undefined ? {} : node.properties;
      if (!record(props) || Object.keys(props).length > 50 ||
        (node.additionalProperties !== undefined && typeof node.additionalProperties !== 'boolean') ||
        (!pageField && node.additionalProperties !== false)) denied();
      if (root) envelope = Object.hasOwn(props,'successful') && Object.hasOwn(props,'data');
      const required = node.required === undefined ? [] : node.required;
      if (!Array.isArray(required) || required.some(k => typeof k !== 'string' || !Object.hasOwn(props,k)) ||
          new Set(required).size !== required.length) denied();
      const fields = new Map(Object.entries(props).map(([key,v]) => [key,compile(v,depth+1)]));
      return value => {
        if (!record(value) || required.some(k => !Object.hasOwn(value,k))) denied();
        for (const [key,v] of Object.entries(value)) {
          const check = fields.get(key);
          if (check) check(v); else if (node.additionalProperties === false) denied();
        }
      };
    }
    if (node.type === 'array') {
      only('type','items','minItems','maxItems');
      const min = node.minItems === undefined ? 0 : node.minItems;
      const max = node.maxItems === undefined && pageField ? MAX_WORKFLOW_ITEMS : node.maxItems;
      if (typeof min !== 'number' || !Number.isSafeInteger(min) || min < 0 || typeof max !== 'number' || !Number.isSafeInteger(max) ||
          min > Math.min(max, MAX_WORKFLOW_ITEMS) || (!pageField && max > MAX_WORKFLOW_ITEMS)) denied();
      const item = compile(node.items,depth+1);
      return value => {
        if (!Array.isArray(value) || value.length < min || value.length > max) denied();
        value.forEach(item);
      };
    }
    const types = Array.isArray(node.type) ? node.type : [node.type];
    if (!types.every(t => ['integer','number','boolean','string','null'].includes(t as string))) denied();
    // Reuse the generic checked scalar dialect (type, enum/const, numeric/string bounds,
    // safe patterns and formats). Do not run input projection on business field names.
    only('type','enum','const','minimum','maximum','minLength','maxLength','format','pattern');
    const {parameters} = directParameterPlan({type:'object',properties:{value:node},required:['value']});
    const verify = (value: unknown) => assertDirectArguments(parameters,{value});
    // Contradictory literal/type (or literal/bound) combinations are not runnable
    // contracts. Check satisfiability of finite vocabularies before dispatch.
    const candidates = Object.hasOwn(node,'const') ? [node.const] : node.enum;
    if (Array.isArray(candidates) && !candidates.some(value => {
      try { verify(value); return true; } catch { return false; }
    })) denied();
    return verify;
  }
  if (!schema && !pageField) denied();
  // Distinguish the transport wrapper by its declared fields, never by trying
  // successive shapes until one validates. Unknown transport fields aren't report data.
  const check = schema && compile(schema,0,true);
  return (response: unknown, args: Dict) => {
    if (!record(response) || !Object.hasOwn(response,'data')) denied();
    const data = response.data;
    validateJson(envelope ? response : data);
    if (pageField) {
      const limit = args[pageField];
      if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_WORKFLOW_ITEMS) denied();
      // No provider-specific collection path: bound every array, including those inside
      // open records and the page-size-only compatibility path (absent/null output schema).
      const cap = (v: unknown): void => {
        if (Array.isArray(v)) { if (v.length > limit) denied(); v.forEach(cap); }
        else if (record(v)) Object.values(v).forEach(cap);
      };
      cap(data);
    }
    if (check) check(envelope ? response : data);
  };
}
