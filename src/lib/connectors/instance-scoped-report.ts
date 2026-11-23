import {resultUnsupported} from './catalog-read-result';
import type {AnalyticsScope} from './supabase-analytics-sources';
import {projectAnalyticsResult} from './supabase-direct-query';
import type {CompiledAnalyticsSelect} from './supabase-select-compiler';
import type {DirectReport} from './provider-direct-output';

const basis = new Map([
  ['paid_sales','Currently completed sales with zero recorded balance; sale date and face value in major units, not a cash receipt date.'],
  ['tender_awards','Approved awards at winning quotation values. Dates are award creation timestamps; net and tax amounts are in minor units.'],
  ['approved_orders','Approved purchase orders, not cash payments. Dates are order creation timestamps; net and tax amounts are in minor units.'],
]);

/** The scoped claim retains its grant epoch in the database. Rendering neither needs
 * that UUID nor constructs a legacy grant, a published view or a follow-up choice. */
export function scopedReport(data:unknown,compiled:CompiledAnalyticsSelect,scope:AnalyticsScope,key:string):DirectReport {
  const {columns,rows,has_more} = projectAnalyticsResult(data,compiled,key);
  const semantics = basis.get(compiled.source);
  if (!semantics || columns.length<1 || columns.length>5 || rows.length>25) resultUnsupported();
  // Currency is the only projected native text field (also under aliases or MIN/MAX).
  // Reject a substituted free-form string rather than storing it in the private destination.
  const cells = rows.map(row=>row.map((v,i)=>{
    if (v !== null && compiled.columns[i].type === 'text' && (v.length!==3 || /[^A-Z]/.test(v))) resultUnsupported();
    return v ?? 'NULL';
  }));
  const report = {title:scope==='platform'?'All-account analytics query':'Workspace analytics query',columns,rows:cells,
    note:`Source: ${compiled.source}. ${semantics} ` + (has_more?'More rows matched than the requested row limit. This is not a complete breakdown.' :
      'Results for the requested filters and scope; NULL is not zero.')};
  const encoded = JSON.stringify(report);
  if (Buffer.byteLength(encoded)>48_000 || encoded.includes(key)) resultUnsupported();
  return report;
}
