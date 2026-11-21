import { spawnSync } from 'node:child_process';
import { compileAnalyticsSelect } from '../supabase-select-compiler';
import { nativeSources } from '../supabase-analytics-native';
import { siteA, siteB, testDataset } from './supabase-select-fixture';

const monthly = `SELECT date_trunc('month', sale_date) AS period, currency, count(distinct site_id) AS sites, count(*) AS sales, sum(amount) AS gross_amount FROM analytics.paid_sales WHERE sale_date >= '2026-01-01' AND sale_date < '2026-10-01' GROUP BY 1,2 ORDER BY 1,2 LIMIT 25`;
const dataset = testDataset({ global:true });
const compile = (sql:string) => compileAnalyticsSelect(sql, undefined, dataset);

test('the reported query compiles to the same grouping and ordering by position, alias or expression', () => {
  const build = (suffix:string) => compileAnalyticsSelect(monthly.replace('GROUP BY 1,2 ORDER BY 1,2',suffix),undefined,{sources:nativeSources('platform'),parameters:[]});
  const plan = build('GROUP BY 1,2 ORDER BY 1,2');
  expect(plan.columns.map(c=>[c.name,c.type])).toEqual([['period','date'],['currency','text'],['sites','integer'],['sales','integer'],['gross_amount','numeric']]);
  for (const suffix of ["GROUP BY date_trunc('month',sale_date),currency ORDER BY date_trunc('month',sale_date),currency", 'GROUP BY period,currency ORDER BY period,currency']) {
    expect(build(suffix).query).toBe(plan.query);
  }
  expect(plan.parameters).toEqual(expect.arrayContaining(['2026-01-01','2026-10-01']));
  expect(plan.query).not.toContain('2026-01-01');
});

const dims = "SELECT date_trunc('month',sale_date) AS period, currency, sum(amount) AS gross FROM sales";
test.each([
  `${dims} GROUP BY 0,2`, `${dims} GROUP BY -1,2`, `${dims} GROUP BY 1.0,2`, `${dims} GROUP BY $1,2`,
  `${dims} GROUP BY 1,4`, `${dims} GROUP BY 1,2,3`, `${dims} GROUP BY period,1,2`,
  `${dims} GROUP BY 1,2 ORDER BY 4`, `${dims} GROUP BY 1,2 ORDER BY period,1`,
  `${dims} GROUP BY 1`, `${dims} GROUP BY sale_date,2`,
  "SELECT date_trunc('month',sale_date) currency, SUM(amount) FROM sales GROUP BY 1",
  "SELECT date_trunc('month',sale_date) period FROM sales", // no platform row projection
  "SELECT date_trunc('month',site_id) period, count(*) FROM sales GROUP BY 1",
  "SELECT date_trunc('month',amount) period, count(*) FROM sales GROUP BY 1",
  "SELECT date_trunc('day',sale_date) period, count(*) FROM sales GROUP BY 1",
  "SELECT date_trunc($1,sale_date) period, count(*) FROM sales GROUP BY 1",
  "SELECT date_trunc('month',sale_date,'UTC') period, count(*) FROM sales GROUP BY 1",
  "SELECT pg_catalog.date_trunc('month',sale_date) period, count(*) FROM sales GROUP BY 1",
  "SELECT date_trunc('month',max(sale_date)) period, count(*) FROM sales GROUP BY 1",
])('rejects out-of-contract grouping before dispatch %#', sql=>{
  expect(()=>compile(sql)).toThrow(expect.objectContaining({code:'INVALID_TOOL_ARGUMENTS'}));
});

test('monthly native sales preserve cutoff, exact currencies, distinct tenants, scope and UTC timestamp boundaries in PostgreSQL',()=>{
  const plans = [
    compileAnalyticsSelect(monthly,undefined,{sources:nativeSources('platform'),parameters:[]}),
    compileAnalyticsSelect(monthly,undefined,{sources:nativeSources('workspace'),parameters:[siteA],allowRows:true}),
    compile("SELECT date_trunc('month',created_at) AS period, COUNT(*) AS events FROM sales GROUP BY period ORDER BY 1 DESC"),
  ];
  const script=`import { PGlite } from '@electric-sql/pglite'; import assert from 'node:assert/strict';
    const db=new PGlite(), plans=${JSON.stringify(plans)};
    async function rows(i){const p=plans[i], f=(await db.query(p.query,p.parameters)).rows[0]; assert.equal(f.analytics_scope,p.attestation);return f.analytics_rows;}
    try { await db.exec(\`CREATE ROLE supabase_read_only_user BYPASSRLS; GRANT pg_read_all_data TO supabase_read_only_user;
      CREATE TABLE sales(site_id uuid,sale_date date,status text,amount numeric,amount_due numeric,currency text);
      INSERT INTO sales VALUES ('${siteA}','2026-01-01','completed',1.11,0,'USD'),('${siteA}','2026-01-09','completed',2.22,0,'USD'),
        ('${siteB}','2026-01-31','completed',3.33,0,'USD'),('${siteA}','2026-01-31','completed',4.44,0,'EUR'),
        ('${siteA}','2026-09-30','completed',5.55,0,'USD'),('${siteB}','2026-10-01','completed',999,0,'EUR'),
        ('${siteA}','2026-08-20','pending',999,999,'USD');
      CREATE TABLE test_sales(site_id uuid,sale_date date,created_at timestamptz,currency text,amount numeric,units int,paid boolean);
      INSERT INTO test_sales(created_at) VALUES ('2026-09-30T23:59:59Z'),('2026-10-01T00:00:00Z'),('2026-09-30T21:15:00-07:00');
      SET TIME ZONE 'America/Los_Angeles'; SET ROLE supabase_read_only_user;\`);
      const r=(period,currency,sites,sales,gross_amount)=>({period,currency,sites,sales,gross_amount});
      const eur=r('2026-01-01','EUR','1','1','4.44'), sep=r('2026-09-01','USD','1','1','5.55');
      assert.deepEqual(await rows(0),[eur,r('2026-01-01','USD','2','3','6.66'),sep]);
      assert.deepEqual(await rows(1),[eur,r('2026-01-01','USD','1','2','3.33'),sep]);
      assert.deepEqual(await rows(2),[{period:'2026-10-01',events:'2'},{period:'2026-09-01',events:'1'}]);
    } finally { await db.close(); }`;
  const out=spawnSync(process.execPath,['--input-type=module','-'],{input:script,encoding:'utf8',timeout:30000});
  if(out.status!==0) throw new Error(out.stderr.slice(-2500)||'SQL verification failed');
},35000);