import { randomBytes,randomUUID } from 'node:crypto';
import { projectAnalyticsResult } from '../supabase-direct-query';
import { privateReport } from '../private-result-report';
import type { CompiledAnalyticsSelect } from '../supabase-select-types';
import { SUPABASE_CATALOG_SLUG } from '../supabase-report-contract';
import { agentRecovery } from '../agent-recovery';
const key=randomBytes(32).toString('hex'), marker=randomUUID();
const plan:CompiledAnalyticsSelect={columns:[{name:'currency',type:'text'},{name:'total',type:'numeric'}],limit:1,source:'paid_sales',query:'',parameters:[],attestation:marker};
const wrap=(rows:unknown,scope:unknown=marker)=>({rows_returned:1,result:[{analytics_scope:scope,analytics_rows:rows}]});
it('separates NULL, confirmed empty and overflow; preserves decimal text and does not expose the lookahead row',()=>{
  const projected=projectAnalyticsResult(wrap([{currency:'USD',total:null},{currency:'MXN',total:'92453490259403388.1345'}]),plan,key);
  expect(projected).toEqual({kind:'analytics',columns:['currency','total'],rows:[['USD',null]],has_more:true});
  const raw={successful:true,data:projected};
  expect(()=>privateReport(SUPABASE_CATALOG_SLUG,true,raw,key)).toThrow();
  const report=privateReport(SUPABASE_CATALOG_SLUG,true,raw,key,{scope:'workspace',grantId:null,projectRef:'a'.repeat(20),source:'paid_sales'});
  expect(report).toMatchObject({rows:[['USD','NULL']],note:expect.stringContaining('not a complete breakdown')});
  expect(projectAnalyticsResult(wrap([]),plan,key)).toMatchObject({rows:[],has_more:false});
  expect(()=>projectAnalyticsResult(wrap(null,null),plan,key)).toThrow(expect.objectContaining({code:'ANALYTICS_SOURCE_UNVERIFIED'}));
});
it('accepts only the one attested read frame with the exact compiler-projected scalar types and bounds',()=>{
  const row={currency:'USD',total:'0.00'};
  for(const data of [wrap([row],randomUUID()),wrap([row,row,row]),wrap([null]),wrap([{...row,total:1.23}]),wrap([{...row,token:key}]),
    wrap([{...row,currency:key}]),wrap([{...row,currency:'a'.repeat(201)}]),wrap([{currency:'USD'}]),{...wrap([row]),rows_returned:0},
    {data:wrap([row])}, {...wrap([row]),logs:[key]}]) {
    expect(()=>projectAnalyticsResult(data,plan,key)).toThrow(expect.objectContaining({code:'CONNECTOR_RESULT_UNSUPPORTED'}));
  }
  expect(agentRecovery('ANALYTICS_WORKSPACE_DENIED')).toMatchObject({action:'ask_manager',message:expect.stringContaining('workspace')});
  expect(agentRecovery('ANALYTICS_WORKSPACE_ONLY')).toMatchObject({action:'ask_user'});
});
