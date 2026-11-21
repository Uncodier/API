import { spawnSync } from 'node:child_process';
import { compileAnalyticsSelect } from '../supabase-select-compiler';
import { getSupabaseAnalyticsDataset as dataset, analyticsSourceHelp as help, analyticsDatasetFingerprint as hash } from '../supabase-analytics-sources';
import { connectorFixture } from './composio-fixtures';

const site = '00000000-0000-4000-8000-000000000001', other = '00000000-0000-4000-8000-000000000002';
const ref = 'a'.repeat(20), c = { ...connectorFixture(), site_id: site, toolkit_slug: 'supabase', supabase_project_ref: ref };
const source = { name: 'bookings', schema: 'makinari_facts_studio', table: 'monthly', siteColumn: 'workspace', columns: [
  {name:'total',column:'gross',type:'numeric'}, {name:'currency',column:'ccy',type:'text',values:['USD','MXN']} ] };
const configure = (sources: unknown[], siteId=site, projectRef=ref) => {
  process.env.CONNECTOR_ANALYTICS_EXTERNAL_DATASETS=JSON.stringify([{ projectRef, siteId, sources }]);
};
const env = ['SUPABASE_URL','NEXT_PUBLIC_SUPABASE_URL','CONNECTOR_ANALYTICS_EXTERNAL_DATASETS','CONNECTOR_ANALYTICS_LOCAL_BINDING'];
let saved: (string|undefined)[];
beforeEach(() => { saved=env.map(k=>process.env[k]); env.forEach(k=>delete process.env[k]); });
afterEach(() => env.forEach((k,i)=> { if(saved[i]===undefined) delete process.env[k]; else process.env[k]=saved[i]; }));

test('native facts use only the verified connector project and effective authorization DB origin', () => {
  expect(help(c)).toBeNull();
  process.env.NEXT_PUBLIC_SUPABASE_URL=`https://${ref}.supabase.co/`;
  expect(dataset(c).parameters).toEqual([site]); expect(dataset(c,'platform').parameters).toEqual([]);
  expect(Object.keys(dataset(c).sources)).toEqual(['paid_sales','tender_awards','approved_orders']);
  expect(help(c)).not.toContain(site); expect(help(c)).not.toContain('connector_analytics');
  expect(help({...c,supabase_project_ref:null})).toBeNull(); expect(help({...c,verified_at:null})).toBeNull();
  expect(help({...c,revocation_pending:true})).toBeNull(); expect(help({...c,site_id:site+'\n'})).toBeNull();
  for (const bad of [`https://${ref}.supabase.co.invalid.test`,`http://${ref}.supabase.co`,`https://${ref}.supabase.co/path`,
    `https://${'b'.repeat(20)}.supabase.co`, 'https://project.example.test']) {
    process.env.SUPABASE_URL=bad; expect(help(c)).toBeNull();
  }
  process.env.CONNECTOR_ANALYTICS_LOCAL_BINDING=`https://project.example.test=${ref}`;
  expect(dataset(c).kind).toBe('native'); expect(help({...c,supabase_project_ref:'b'.repeat(20)})).toBeNull();
  process.env.SUPABASE_URL=`https://${'b'.repeat(20)}.supabase.co`; process.env.CONNECTOR_ANALYTICS_LOCAL_BINDING=`${process.env.SUPABASE_URL}=${ref}`;
  expect(help(c)).toBeNull();
});

test('external sources are explicitly mapped per verified ref AND site, without global access or free text/SQL', () => {
  configure([source],other); expect(help(c)).toBeNull(); configure([source],site,'b'.repeat(20)); expect(help(c)).toBeNull();
  configure([source]); expect(dataset(c).parameters).toEqual([site]); expect(dataset(c).kind).toBe('external');
  expect(help(c)).toContain('bookings('); expect(help(c)).not.toMatch(/studio|monthly|gross|ccy|workspace:/);
  expect(() => dataset(c,'platform')).toThrow(expect.objectContaining({code:'ANALYTICS_WORKSPACE_ONLY'}));
  configure([{...source,money:{currency:'currency',measures:['total']}}]); expect(dataset(c).sources.bookings.money).toEqual({currency:'currency',measures:['total']});
  const before=hash(c); configure([{...source,table:'quarterly'}]); expect(hash(c)).not.toBe(before);
  for(const bad of [{...source,table:'public.sales'}, {...source,schema:'public'}, {...source,name:'__proto__'},
    ...['paid_sales','tender_awards','approved_orders'].map(name=>({...source,name})),
    {...source,columns:[{name:'label',column:'ccy',type:'text',values:['NULL']}]},
    {...source,name:'test\n'}, {...source,columns:[{name:'raw',column:'details',type:'text'}]},
    {...source,columns:[{name:'name',column:'free',type:'text',values:["a'b"]}]}, {...source,columns:[{name:'site_id',column:'value',type:'numeric'}]},
    {...source,sql:'SELECT 1'}, {...source,money:{currency:'total',measures:['total']}},
    {...source,money:{currency:'currency',measures:['missing']}}, {...source, columns:[{name:'bad',column:'workspace',type:'numeric'}]}]) {
    configure([bad]); expect(help(c)).toBeNull();
  }
  configure([source,source]); expect(help(c)).toBeNull();
});

test('mapped compiled source checks every column type, relation ownership and inactive RLS in the same synthetic database statement', () => {
  configure([source]); const q=compileAnalyticsSelect('SELECT currency, SUM(total) AS money, COUNT(DISTINCT site_id) AS accounts FROM bookings GROUP BY currency ORDER BY currency', undefined,dataset(c));
  const script = `import { PGlite } from '@electric-sql/pglite'; import assert from 'node:assert/strict';
    const db=new PGlite(), q=${JSON.stringify(q)}; const frame=async ()=> (await db.query(q.query,q.parameters)).rows[0];
    try {
      await db.exec(\`CREATE ROLE supabase_read_only_user; CREATE ROLE other; CREATE SCHEMA makinari_facts_studio;
        CREATE TABLE makinari_facts_studio.monthly(workspace uuid, gross numeric, ccy text);
        INSERT INTO makinari_facts_studio.monthly VALUES ('${site}',12.34,'USD'),('${site}',1.02,'USD'),('${other}',999,'USD'),('${site}',2,'non-categorical');
        GRANT USAGE ON SCHEMA makinari_facts_studio TO supabase_read_only_user;
        GRANT SELECT (workspace,gross,ccy) ON makinari_facts_studio.monthly TO supabase_read_only_user;
        SET ROLE supabase_read_only_user;\`);
      assert.deepEqual(await frame(),{analytics_scope:q.attestation, analytics_rows:[{currency:'USD',money:'13.36',accounts:'1'},{currency:null,money:'2',accounts:'1'}]});
      for(const change of ['ALTER TABLE makinari_facts_studio.monthly ENABLE ROW LEVEL SECURITY',
        'ALTER TABLE makinari_facts_studio.monthly OWNER TO other','ALTER SCHEMA makinari_facts_studio OWNER TO other',
        'ALTER TABLE makinari_facts_studio.monthly ALTER COLUMN gross TYPE bigint']) {
        await db.exec('BEGIN; RESET ROLE; '+change+'; SET ROLE supabase_read_only_user'); assert.deepEqual(await frame(),{analytics_scope:null,analytics_rows:null});
        await db.exec('ROLLBACK');
      }
    } finally { await db.close(); }`;
  const r = spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:30000});
  if(r.status!==0) throw new Error(r.stderr.slice(-1800)||'Local SQL check failed');
},35000);
