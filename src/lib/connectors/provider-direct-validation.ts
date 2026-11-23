import { validateJson } from './composio-transport';
import { findToolArgumentIssue, schemaFieldPath, type ToolArgumentIssue } from '@/lib/tools/argument-contract';
import { CONNECTOR_MAX_STRING_UNITS } from './public-input-schema';
import { ConnectorArgumentError } from './connector-argument-error';
import { ConnectorError } from './types';

type Dict = Record<string, unknown>;
const error = (issue: ToolArgumentIssue): never => {throw new ConnectorArgumentError(issue);};
const unsafe = (): never => {throw new ConnectorError('CONNECTOR_UNSAFE_ARGUMENT','External targets, executable inputs and file paths are not supported.',409);};

// Only accept ONE anchored character class (ASCII ranges/literals), with a bounded
// repetition or +/*. No groups, alternation, escapes, lookarounds or nested quantifiers.
// This is linear on our bounded strings and cannot turn provider metadata into code.
export function safeDirectPattern(v: unknown): v is string {
  if (typeof v!=='string' || v.length>100 || /[\r\n]/.test(v)) return false;
  if (!/^\^\[[a-zA-Z0-9_.-]{1,64}\](?:[+*]|\{[0-9]{1,4}(?:,[0-9]{0,4})?\})\$$/.test(v)) return false;
  try { new RegExp(v,'u'); return true; } catch { return false; }
}

/** Validate the projected/checked direct contract only. Shared JSON safety, limits and
 * diagnostics apply without treating an ordinary nested business field named `text`
 * as Composio's top-level natural language execution option. No coercion or defaults. */
export function assertDirectArguments(schema: Dict, args: unknown): asserts args is Dict {
  validateJson(args);
  if (args===null || typeof args!=='object' || Array.isArray(args)) error({path:'arguments',rule:'json_object'});
  if (Buffer.byteLength(JSON.stringify(args))>32_000) error({path:'arguments',rule:'bounded'});
  let checks = 0;
  function visit(s: Dict, v: unknown, path: string): void {
    if (++checks > 25_000) throw new ConnectorError('CONNECTOR_INVALID_INPUT', 'Argument validation limit exceeded.', 400);
    if (Array.isArray(s.anyOf)) {
      for (const arm of s.anyOf) {
        try { visit(arm,v,path); return; } catch(e) {if (!(e instanceof ConnectorArgumentError)) throw e;}
      }
      error({path,rule:'choice'});
    }
    const types=Array.isArray(s.type)?s.type:[s.type];
    const actual=v===null?'null':Array.isArray(v)?'array':typeof v;
    if (!types.includes(actual) && !(actual==='number' && types.includes('integer') && Number.isSafeInteger(v))) {
      error({path,rule:'type',expected:types.join(' or ')});
    }
    if (Array.isArray(s.enum) && !s.enum.includes(v)) error({path,rule:'enum'});
    if (Object.hasOwn(s,'const') && s.const!==v) error({path,rule:'const'});
    if (typeof v==='number') {
      if (!Number.isFinite(v) || (Number.isInteger(v) && !Number.isSafeInteger(v))) error({path,rule:'bounded'});
      if (typeof s.minimum==='number' && v<s.minimum) error({path,rule:'minimum',bound:s.minimum});
      if (typeof s.maximum==='number' && v>s.maximum) error({path,rule:'maximum',bound:s.maximum});
    } else if (typeof v==='string') {
      if (v.length>CONNECTOR_MAX_STRING_UNITS) error({path,rule:'bounded'});
      const target = v.trim();
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(v) ||
        /(?:[a-z][a-z\d+.-]{0,30}:\/\/|\b(?:file|data|javascript|vbscript):|\\|^(?:~?\/|\.{1,2}\/)|(?:^|\s)\.\.\/)/i.test(target) ||
        /<\/?script\b|^\s*(?:#!|-----BEGIN .*PRIVATE KEY-----)|\b(?:select\s+[^;]+\s+from|insert\s+into|delete\s+from|drop\s+(?:table|database)|alter\s+table)\b/i.test(v)) unsafe();
      const n=[...v].length;
      if (typeof s.minLength==='number' && n<s.minLength) error({path,rule:'minLength',bound:s.minLength});
      if (typeof s.maxLength==='number' && n>s.maxLength) error({path,rule:'maxLength',bound:s.maxLength});
      if (s.pattern!==undefined && (!safeDirectPattern(s.pattern) || !new RegExp(s.pattern,'u').test(v))) error({path,rule:'contract'});
    } else if (Array.isArray(v)) {
      if (typeof s.minItems==='number' && v.length<s.minItems) error({path,rule:'minItems',bound:s.minItems});
      if (typeof s.maxItems==='number' && v.length>s.maxItems) error({path,rule:'maxItems',bound:s.maxItems});
      v.forEach((val,i)=>visit(s.items as Dict,val,`${path}[${i}]`));
    } else if (v && typeof v==='object') {
      const props=s.properties as Dict;
      for (const key of (s.required as string[]|undefined)??[]) if (!Object.hasOwn(v,key)) error({path:schemaFieldPath(path,key),rule:'required'});
      for (const [key,val] of Object.entries(v)) {
        if (!Object.hasOwn(props,key)) error({path,rule:'extra'});
        visit(props[key] as Dict,val,schemaFieldPath(path,key));
      }
    }
  }
  try {visit(schema,args,'arguments');} catch(e) {
    if (e instanceof ConnectorArgumentError && e.issue.rule==='choice') error(findToolArgumentIssue(schema,args)??e.issue);
    throw e;
  }
}
