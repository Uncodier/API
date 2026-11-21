import { randomBytes } from 'node:crypto';
import { privateReport } from '../private-result-report';
const secret=randomBytes(32).toString('hex');
const run=(tool:string, data:unknown, catalog=true)=>privateReport(tool,catalog,{successful:true,data,logs:[{echo:secret}],log_id:secret},secret);
const report='SUPABASE_RUN_READ_ONLY_QUERY';
it('supports all bounded catalog views, continuation and report values without storing provider diagnostics or advice',()=>{
  const list=run(report,{views:['sales'],has_more:true,next_after:'sales',guidance:secret});
  expect(list).toMatchObject({published:true,rows:[['sales']],next_after:'sales'}); expect(JSON.stringify(list)).not.toContain(secret);
  expect(run(report,{view:'sales',rows:[{label:'USD',value:'12345678901234567890123456789012'}],debug:secret})).toMatchObject({rows:[['USD','12345678901234567890123456789012']]});
  expect(run(report,{status:'not_available',guidance:secret})).toMatchObject({rows:[],note:expect.stringMatching(/administrator/)});
  expect(run('BOOKS_LIST_EDITIONS',{items:[{id:2,name:'Edition 1',nested:{token:secret}}]})).toMatchObject({rows:[['2','Edition 1','']]});
});
it('allows only reviewed display fields: never passes a legacy instance envelope, contact properties, message bodies, metadata or tokens',()=>{
  for (const value of [run('HUBSPOT_LIST_CONTACTS',{results:[{id:'12',properties:{firstname:'Pat',lastname:'Lee',email:secret}}]},false),
    run('GMAIL_FETCH_EMAILS',{messages:[{id:'12345',subject:'Quote',body:secret,attachments:[{name:secret}]}],nextPageToken:secret},false),
    run('SUPABASE_LIST_TABLES',{tables:[{schema:'public',name:'test',rows:[secret]}],coverage:secret},false)]) {
    expect(JSON.stringify(value)).not.toContain(secret); expect(value.rows).toHaveLength(1);
  }
  const large=run('GMAIL_FETCH_EMAILS',{messages:Array(105).fill({id:'123',subject:'test'})},false);
  expect(large.rows).toHaveLength(100); expect(large.note).toContain('Only the first 100');
});
it('fails closed on unknown/malformed, unprojectable or secret-echoing data',()=>{
  for(const task of [()=>run(report,{views:['safe'],next_after:'secret',has_more:true}),()=>run(report,{view:'auth_token',rows:[]}),
    ()=>run(report,{view:'sales',rows:[{value:'-oops',label:'x'}]}),()=>run('HUBSPOT_LIST_CONTACTS',{},false),
    ()=>run('GMAIL_FETCH_EMAILS',{messages:[{subject:secret}]},false),()=>run('OTHER',{items:[{note:secret}]})]) expect(task).toThrow();
});
