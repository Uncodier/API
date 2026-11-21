import { spawnSync } from 'node:child_process';
import { nativeSources } from '../supabase-analytics-native';
import { compileAnalyticsSelect } from '../supabase-select-compiler';

const one = '00000000-0000-4000-8000-000000000001', two = '00000000-0000-4000-8000-000000000002';
const id = (n:number) => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const s = 'SELECT currency,SUM(amount) AS value,COUNT(DISTINCT site_id) AS sites FROM paid_sales GROUP BY currency ORDER BY currency';
const p = (source:string) => `SELECT currency,SUM(net_amount_minor) AS value,COUNT(DISTINCT site_id) AS sites FROM ${source} GROUP BY currency ORDER BY currency`;

test('actual compiled native SQL scopes every joined relation; underprivileged RLS/role drift cannot attest zero', () => {
  const plans = [s,p('tender_awards'),p('approved_orders')].map(query => (['workspace','platform'] as const).map(scope =>
    compileAnalyticsSelect(query,undefined,{ sources:nativeSources(scope),parameters:scope==='workspace'?[one]:[] })));
  const setup = `CREATE ROLE supabase_read_only_user BYPASSRLS; GRANT pg_read_all_data TO supabase_read_only_user;
    CREATE TABLE sales(site_id uuid,sale_date date,status text,amount numeric,amount_due numeric,currency text);
    INSERT INTO sales VALUES ('${one}','2014-01-01','completed',12.25,0,' usd '),('${one}','2015-01-01','completed',100,0,'MXN'),
      ('${two}','2010-01-01','completed',21.25,0,'USD'),('${one}','2021-01-01','completed',1,1,'USD'),
      ('${one}','2021-01-01','completed',2,NULL,'USD'),('${one}','2022-01-01','pending',4,0,'USD'),('${one}','2021-01-01','refunded',3,0,'USD'),(NULL,'2021-01-01','completed',500,0,'USD');
    CREATE TABLE procurement_event_approvals(id uuid,site_id uuid,target_id uuid,event text,status text);
    CREATE TABLE quotations(id uuid,buyer_site_id uuid,procurement_supplier_id uuid,procurement_tender_id uuid,purpose text,
      currency text,procurement_net_minor bigint,procurement_tax_minor bigint);
    CREATE TABLE procurement_awards(id uuid,site_id uuid,tender_id uuid,quotation_id uuid,supplier_id uuid,approval_id uuid,created_at timestamptz DEFAULT now());
    CREATE TABLE purchase_orders(id uuid,site_id uuid,award_id uuid,quotation_id uuid,supplier_id uuid,approval_id uuid,
      currency text,net_amount_minor bigint,tax_amount_minor bigint,created_at timestamptz DEFAULT now());
    ${[one,two].map((site,i)=>{
      const [award,quote,supplier,tender,approval,orderApproval,order] = Array.from({length:7},(_,j)=>id(10+i*10+j));
      return `INSERT INTO procurement_event_approvals VALUES ('${approval}','${site}','${quote}','award','approved'),('${orderApproval}','${site}','${award}','order','approved');
        INSERT INTO quotations VALUES ('${quote}','${site}','${supplier}','${tender}','procurement','EUR',${200+i},45);
        INSERT INTO procurement_awards(id,site_id,tender_id,quotation_id,supplier_id,approval_id) VALUES ('${award}','${site}','${tender}','${quote}','${supplier}','${approval}');
        INSERT INTO purchase_orders(id,site_id,award_id,quotation_id,supplier_id,approval_id,currency,net_amount_minor,tax_amount_minor)
          VALUES ('${order}','${site}','${award}','${quote}','${supplier}','${orderApproval}','EUR',${200+i},45);`;
    }).join('\n')}
    ${['sales','quotations','purchase_orders','procurement_event_approvals','procurement_awards'].map(t=>`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`).join('\n')}`;
  const script=`import { PGlite } from '@electric-sql/pglite'; import assert from 'node:assert/strict';
    const db=new PGlite(), plans=${JSON.stringify(plans)}, denied={analytics_scope:null,analytics_rows:null};
    const run=async (i,scope)=>{ const p=plans[i][scope];return (await db.query(p.query,p.parameters)).rows[0]; };
    const rows=async(i,scope)=> { const f=await run(i,scope); assert.equal(f.analytics_scope,plans[i][scope].attestation);return f.analytics_rows; };
    try { await db.exec(${JSON.stringify(setup)}); assert.deepEqual(await run(0,1),denied);
      await db.exec('SET ROLE supabase_read_only_user'); const r=(currency,value,sites)=>({currency,value,sites});
      assert.deepEqual(await rows(0,0),[r('MXN','100','1'),r('USD','12.25','1')]);
      assert.deepEqual(await rows(0,1),[r('MXN','100','1'),r('USD','33.50','2')]);
      for(const i of [1,2]) { assert.deepEqual(await rows(i,0),[r('EUR','200','1')]);assert.deepEqual(await rows(i,1),[r('EUR','401','2')]); }
      await db.exec(\`RESET ROLE; UPDATE quotations SET buyer_site_id='${two}' WHERE buyer_site_id='${one}';
        UPDATE procurement_event_approvals SET site_id='${two}' WHERE site_id='${one}' AND event='order'; SET ROLE supabase_read_only_user;\`);
      assert.deepEqual(await rows(1,0),[]); assert.deepEqual(await rows(2,0),[]);
      for(const i of [1,2]) assert.deepEqual(await rows(i,1),[r('EUR','201','1')]);
      await db.exec('RESET ROLE; ALTER ROLE supabase_read_only_user NOBYPASSRLS; SET ROLE supabase_read_only_user;');
      for(const i of [0,1,2]) assert.deepEqual(await run(i,0),denied);
    } finally { await db.close(); }`;
  const result = spawnSync(process.execPath,['--input-type=module','-'],{input:script,encoding:'utf8',timeout:30000});
  if(result.status!==0) throw new Error(result.stderr?.slice(-1800)||'Native analytics SQL check failed');
},35000);
