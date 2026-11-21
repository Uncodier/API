import { analyticsSourceHelp, type BoundDataset, type AnalyticsScope } from './supabase-analytics-sources';
import { type AnalyticsResultType, type CompiledAnalyticsSelect } from './supabase-select-types';
import { resultUnsupported } from './catalog-read-result';
import { ConnectorError } from './types';

export type AnalyticsReport = { kind:'analytics'; columns:string[]; rows:(string|null)[][]; has_more:boolean };
export type AnalyticsPermit = (request: { source:string; scope:AnalyticsScope; projectRef:string }) => Promise<void>;
const object = (v:unknown):v is Record<string,unknown> => !!v && typeof v==='object' && !Array.isArray(v);
const exact = (v:unknown,keys:readonly string[]):v is Record<string,unknown> => object(v) &&
  Object.keys(v).length===keys.length && keys.every(k=>Object.hasOwn(v,k));
const invalid = () => new ConnectorError('INVALID_TOOL_ARGUMENTS', 'Supply query, optional positional parameters and workspace or platform scope. Do not mix SQL with view listing or pagination arguments.', 400);
export function directQueryMode(args:Record<string,unknown>): AnalyticsScope | null {
  if (!Object.hasOwn(args,'query')) {
    if (Object.hasOwn(args,'parameters') || Object.hasOwn(args,'scope')) throw invalid();
    return null;
  }
  if (typeof args.query !== 'string' || !args.query.trim() || Buffer.byteLength(args.query)>4096 ||
      Object.keys(args).some(k=>!['query','parameters','scope'].includes(k)) ||
      (args.scope!==undefined && args.scope!=='workspace' && args.scope!=='platform')) throw invalid();
  return args.scope==='platform' ? 'platform' : 'workspace';
}

/** The agent gets logical columns but neither physical table bindings nor bearer material. */
export function directQueryFields(dataset: BoundDataset) {
  const help = analyticsSourceHelp(dataset);
  const scopes = dataset.kind === 'native' ? ['workspace','platform'] : ['workspace'];
  return {
    query:{type:'string',minLength:1,maxLength:4096,description:'For a data question send a single SQL SELECT on one of these sources (prefix analytics.). No published report is required. Supports filters, aggregates, groups, ordering and LIMIT up to 25. Workspace can also project listed nonidentifying fields. Platform queries must aggregate. For money aggregates, group and report the currency or filter to one currency; explain the date basis. '+help},
    parameters:{type:'array',maxItems:16,items:{anyOf:[{type:'string',maxLength:200},{type:'number'},{type:'boolean'}]},
      description:'Optional scalar bind values for $1, $2, etc. Use strings for exact decimals and large integers, ISO dates, and timestamps with timezone. Put LIMIT in the SELECT.'},
    scope:{type:'string',enum:scopes,default:'workspace',description:'Requested scope, not a permission. Use platform only for an explicitly all-account request with a matching independent platform grant. Never substitute workspace totals for platform totals.'},
  };
}

const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const integer = /^-?(?:0|[1-9]\d*)$/;
const date = /^\d{4}-\d\d-\d\d$/;
const stamp = /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d(?::?\d\d)?)$/;
function cell(type: AnalyticsResultType, value: unknown, key:string): string | null {
  if (value===null) return null;
  if (typeof value!=='string' || Buffer.byteLength(value)>200 || value.includes(key) || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value)) resultUnsupported();
  // PostgreSQL serializes numbers as text in the compiled projection. Never round money in JavaScript.
  if ((type==='numeric' && !number.test(value)) || (type==='integer' && !integer.test(value)) ||
      (type==='date' && !date.test(value)) || (type==='timestamptz' && !stamp.test(value)) ||
      (type==='boolean' && !['true','false'].includes(value))) resultUnsupported();
  return value;
}

/** Decode only our own single-row SQL result under the pinned Composio result wrapper. No
 * arbitrary provider document or diagnostics, attestation, query text or parameters in the DTO. */
export function projectAnalyticsResult(raw:unknown, plan:CompiledAnalyticsSelect, key:string): AnalyticsReport {
  if (!key || (!exact(raw,['result']) && !exact(raw,['result','rows_returned'])) ||
    (Object.hasOwn(raw,'rows_returned') && raw.rows_returned!==1) || !Array.isArray(raw.result) || raw.result.length!==1) resultUnsupported();
  const frame:unknown=raw.result[0];
  if (!exact(frame,['analytics_scope','analytics_rows'])) resultUnsupported();
  if (frame.analytics_scope===null && frame.analytics_rows===null) {
    throw new ConnectorError('ANALYTICS_SOURCE_UNVERIFIED','The query source or read authority could not be verified. No total was confirmed.',409);
  }
  if (frame.analytics_scope!==plan.attestation || !Array.isArray(frame.analytics_rows) || frame.analytics_rows.length>plan.limit+1) resultUnsupported();
  const columns=plan.columns.map(c=>c.name);
  const rows=frame.analytics_rows.map(row=>{
    if (!exact(row,columns)) resultUnsupported();
    return plan.columns.map(col=>cell(col.type,row[col.name],key));
  });
  return { kind:'analytics', columns, rows:rows.slice(0,plan.limit), has_more:rows.length>plan.limit };
}
