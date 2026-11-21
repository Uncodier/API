// Public diagnostics contain only schema-owned field paths, fixed rules and declared bounds.
// Never include a submitted value/key, provider message, schema description, enum or default.
const jsonTypes = ['null', 'boolean', 'integer', 'number', 'string', 'array', 'object'] as const;
type JsonType = typeof jsonTypes[number];
type Rule = 'json_object' | 'required' | 'type' | 'extra' | 'choice' | 'enum' | 'const' | 'minimum' | 'maximum' |
  'minLength' | 'maxLength' | 'minItems' | 'maxItems' | 'bounded' | 'plain_text' | 'contract';
export type ToolArgumentIssue = { path: string; rule: Rule; expected?: string; bound?: number };

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
function jsonType(t: unknown): t is JsonType { return jsonTypes.some(type => type === t); }
function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!record(value)) return false;
  const proto=Object.getPrototypeOf(value);return proto===Object.prototype || proto===null;
}
function hasType(t: JsonType, v: unknown) {
  if (t === 'object') return record(v);
  if (t === 'array') return Array.isArray(v);
  if (t === 'integer') return Number.isInteger(v);
  if (t === 'number') return finite(v);
  return t === 'null' ? v === null : typeof v === t;
}

/** Only pass names declared in the visible schema. Unknown submitted keys stay at the parent path. */
export function schemaFieldPath(parent: string, name: string): string {
  if(parent.length>=156) return parent;
  return /^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(name) && !/[^A-Za-z0-9_]/.test(name) && !Object.hasOwn(Object.prototype, name) && name !== 'prototype'
    ? `${parent}.${name}` : `${parent}.*`;
}

export function argumentFailure(issue: ToolArgumentIssue) {
  const { path, bound, expected } = issue;
  const messages: Record<Rule, string> = {
    json_object: 'Supply one valid JSON object, not an array, primitive, or malformed JSON string.',
    required: `Supply the required field ${path}.`, type: `Use ${expected ?? 'the described JSON type'} for ${path}.`,
    extra: `Remove fields not declared for ${path}.`, choice: `Use one compatible argument form described for ${path}; do not mix alternatives.`,
    enum: `Choose a value declared in the enum for ${path}.`, const: `Use the fixed value described for ${path}.`,
    minimum: `Use a number at least ${bound} for ${path}.`, maximum: `Use a number no greater than ${bound} for ${path}.`,
    minLength: `Use at least ${bound} characters for ${path}.`, maxLength: `Use at most ${bound} characters for ${path}.`,
    minItems: `Supply at least ${bound} items for ${path}.`, maxItems: `Supply at most ${bound} items for ${path}.`,
    bounded: `Reduce the size or nesting of ${path}.`, plain_text: `Use plain text, not a URL or file path, for ${path}.`,
    contract: `Use the currently described contract for ${path}.`,
  };
  const message = messages[issue.rule];
  return { success: false as const, code: 'INVALID_TOOL_ARGUMENTS' as const, error: message, argument_issue: issue,
    recovery: { action: 'fix_arguments' as const, message: `${message} Correct the input for this same tool and scope. Do not replay it unchanged.` },
    executed: false as const, effectStarted: false as const, automatic_retry: false as const };
}

type Check = ToolArgumentIssue | null | undefined; // invalid, checked, or defer to the executor
const keywords = new Set(['type','properties','required','additionalProperties','items','enum','const','minimum','maximum',
  'minItems','maxItems','minLength','maxLength','description','title','default','examples','$schema','anyOf','oneOf','allOf']);
const scalar = (v: unknown) => v === null || typeof v === 'boolean' || typeof v === 'string' || finite(v);

/** A bounded preflight, not an authorization decision or a replacement for the tool's actual validator.
 * Unsupported dialects ($ref, conditionals, regexes, etc.) and over-budget inputs defer. No IO or coercion. */
export function findToolArgumentIssue(schema: unknown, input: unknown, options: {allowNativeWireCompatibility?: boolean} = {}): ToolArgumentIssue | null {
  let left = 4096;
  function visit(s: unknown, v: unknown, path: string, depth: number): Check {
    if (--left < 0 || depth > 16 || !plainRecord(s) || Object.keys(s).some(k => !keywords.has(k))) return undefined;
    if (record(v) && !plainRecord(v)) return undefined;
    const types = s.type === undefined ? [] : Array.isArray(s.type) ? s.type : [s.type];
    if (types.length > 7 || !types.every(jsonType)) return undefined;
    if (types.length && !types.some(t => hasType(t,v))) {
      // Some native adapters accept an encoded string as well as a structured value. Only the
      // executor knows this. Never coerce it, skip a sibling check, or apply this to connectors.
      if (options.allowNativeWireCompatibility && depth>0 &&
          ((types.includes('string') && (record(v)||Array.isArray(v))) ||
           (typeof v==='string' && (types.includes('object')||types.includes('array'))))) return undefined;
      return {path,rule:'type',expected:types.join(' or ')};
    }
    let uncertain = false;
    if (Object.hasOwn(s,'enum')) {
      if (!Array.isArray(s.enum) || s.enum.length>100 || !s.enum.every(scalar)) uncertain=true;
      else if (!s.enum.some(option=>option===v)) return {path,rule:'enum'};
    }
    if (Object.hasOwn(s,'const')) {
      if (!scalar(s.const)) uncertain=true;
      else if (v!==s.const) return {path,rule:'const'};
    }
    for (const keyword of ['allOf','anyOf','oneOf'] as const) {
      const alternatives = s[keyword]; if (alternatives === undefined) continue;
      if (!Array.isArray(alternatives) || !alternatives.length || alternatives.length>12) return undefined;
      const results = alternatives.map(child => visit(child, v, path, depth+1));
      if (keyword === 'allOf') { const failure=results.find(r=>!!r); if (failure) return failure; }
      else {
        const passes = results.filter(r=>r===null).length;
        if (keyword==='oneOf' && passes>1) return {path,rule:'choice'};
        if (passes===0 && !results.includes(undefined)) {
          // A wrong type in the nullable arm is not the useful failure when the other arm matched the type.
          const specific=results.filter((r):r is ToolArgumentIssue=>!!r && !(r.path===path && r.rule==='type'));
          if (specific.length===1) return specific[0];
          if (results.every(r=>r?.rule==='type' && r.path===path)) {
            const expected=[...new Set(results.flatMap(r=>r!.expected!.split(' or ')))].join(' or ');
            return {path,rule:'type',expected};
          }
          return {path,rule:'choice'};
        }
        if (keyword==='anyOf' && passes) continue;
      }
      uncertain ||= results.includes(undefined);
    }
    if (typeof v==='number') {
      if (finite(s.minimum) && v<s.minimum) return {path,rule:'minimum',bound:s.minimum};
      if (finite(s.maximum) && v>s.maximum) return {path,rule:'maximum',bound:s.maximum};
    }
    if (typeof v==='string' && (finite(s.minLength)||finite(s.maxLength))) {
      // Stop counting once the largest applicable threshold is crossed (Unicode code points).
      const stop=Math.max(finite(s.minLength)?s.minLength:0, finite(s.maxLength)?s.maxLength:0);
      let n=0; for (const _ of v) { if (++n>stop) break; }
      if (finite(s.minLength) && n<s.minLength) return {path,rule:'minLength',bound:s.minLength};
      if (finite(s.maxLength) && n>s.maxLength) return {path,rule:'maxLength',bound:s.maxLength};
    }
    if (Array.isArray(v)) {
      if (finite(s.minItems) && v.length<s.minItems) return {path,rule:'minItems',bound:s.minItems};
      if (finite(s.maxItems) && v.length>s.maxItems) return {path,rule:'maxItems',bound:s.maxItems};
      if (s.items!==undefined) for (let i=0;i<v.length;i++) {
        if (left<1) return undefined;
        const child=visit(s.items,v[i],`${path}[${i}]`,depth+1);
        if (child) return child; uncertain ||= child===undefined;
      }
    }
    if (record(v)) {
      const props=record(s.properties) ? s.properties : {};
      if (Array.isArray(s.required)) for (const k of s.required) {
        if (typeof k==='string' && !Object.hasOwn(v,k)) return {path:schemaFieldPath(path,k),rule:'required'};
      }
      for (const k of Object.keys(v)) {
        if (left<1) return undefined;
        if (!Object.hasOwn(props,k)) {
          if (s.additionalProperties===false) return {path,rule:'extra'};
          if (record(s.additionalProperties)) {
            const child=visit(s.additionalProperties,v[k],`${path}.*`,depth+1);
            if (child) return child; uncertain ||= child===undefined;
          }
          continue;
        }
        const child=visit(props[k],v[k],schemaFieldPath(path,k),depth+1);
        if (child) return child; uncertain ||= child===undefined;
      }
    }
    return uncertain ? undefined : null;
  }
  return visit(schema,input,'arguments',0) ?? null;
}