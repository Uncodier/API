import { spawnSync } from 'node:child_process';
import { compileAnalyticsSelect } from '../supabase-select-compiler';
import { scopedDataset, resolveAnalyticsCapability as capability, analyticsSourceHelp as help, analyticsDatasetFingerprint as hash } from '../supabase-analytics-sources';
import { loadExternalDataset } from '../supabase-analytics-registry';
import { externalDataset } from '../supabase-analytics-external';
import { ConnectorError } from '../types';

jest.mock('../supabase-analytics-registry', () => ({loadExternalDataset:jest.fn()}));
const registry = jest.mocked(loadExternalDataset);
import { connectorFixture } from './composio-fixtures';

const site = '00000000-0000-4000-8000-000000000001', other = '00000000-0000-4000-8000-000000000002';
const ref = 'a'.repeat(20), c = { ...connectorFixture(), site_id: site, toolkit_slug: 'supabase', supabase_project_ref: ref };
const source = { name: 'bookings', schema: 'makinari_facts_studio', table: 'monthly', siteColumn: 'workspace', columns: [
  {name:'total',column:'gross',type:'numeric'}, {name:'currency',column:'ccy',type:'text',values:['USD','MXN']} ] };
const mapped = (sources: unknown[], siteId=site, projectRef=ref) => externalDataset(ref,site,{projectRef,siteId,sources});
beforeEach(() => { registry.mockReset(); });

test('one installation identity applies to all verified accounts and logical sources, never a platform grant',async()=>{
  for (const site_id of [site, other]) {
    const cap = await capability({...c,site_id},ref);
    const ws = scopedDataset(cap,'workspace');
    expect(ws.parameters).toEqual([site_id]); expect(scopedDataset(cap,'platform').parameters).toEqual([]);
    expect(Object.keys(ws.sources)).toEqual(['paid_sales','tender_awards','approved_orders']);
    expect(help(ws)).not.toContain(site_id); expect(help(ws)).not.toContain('connector_result_private');
  }
  for(const bad of [{supabase_project_ref:null},{verified_at:null},{revocation_pending:true},{site_id:site+'\n'}]) {
    await expect(capability({...c,...bad},ref)).rejects.toMatchObject({code:'CONNECTOR_PROJECT_UNBOUND'});
  }
  expect(registry).not.toHaveBeenCalled();
  expect(await capability(c,undefined)).toEqual({status:'unverified'}); expect(registry).not.toHaveBeenCalled();
});

test('external sources resolve only by exact registered site AND project; no global access, free text or SQL', async () => {
  const local = 'b'.repeat(20);
  expect(mapped([source],other)).toBeNull();expect(mapped([source],site,'b'.repeat(20))).toBeNull();
  registry.mockResolvedValue(null);expect(await capability(c,local)).toEqual({status:'unmapped'});
  registry.mockRejectedValueOnce(new ConnectorError('CATALOG_AUTHORIZATION_UNAVAILABLE','Unavailable',503));
  expect(await capability(c,local)).toEqual({status:'unavailable'});
  registry.mockResolvedValue(mapped([source])); const cap = await capability(c,local); const ws = scopedDataset(cap,'workspace');
  expect(registry).toHaveBeenCalledWith(c);expect(ws.parameters).toEqual([site]);expect(ws.kind).toBe('external');
  expect(help(ws)).toContain('bookings('); expect(help(ws)).not.toMatch(/studio|monthly|gross|ccy|workspace:/);
  expect(()=>scopedDataset(cap,'platform')).toThrow(expect.objectContaining({code:'ANALYTICS_WORKSPACE_ONLY'}));
  expect(mapped([{...source,money:{currency:'currency',measures:['total']}}])?.sources.bookings.money).toEqual({currency:'currency',measures:['total']});
  registry.mockResolvedValue(mapped([{...source,table:'quarterly'}]));
  expect(hash(scopedDataset(await capability(c,local),'workspace'))).not.toBe(hash(ws));
  for(const bad of [{...source,table:'public.sales'}, {...source,schema:'public'}, {...source,name:'__proto__'},
    ...['paid_sales','tender_awards','approved_orders'].map(name=>({...source,name})),
    {...source,columns:[{name:'label',column:'ccy',type:'text',values:['NULL']}]},
    {...source,name:'test\n'}, {...source,columns:[{name:'raw',column:'details',type:'text'}]},
    {...source,columns:[{name:'name',column:'free',type:'text',values:["a'b"]}]}, {...source,columns:[{name:'site_id',column:'value',type:'numeric'}]},
    {...source,sql:'SELECT 1'}, {...source,money:{currency:'total',measures:['total']}},
    {...source,money:{currency:'currency',measures:['missing']}}, {...source, columns:[{name:'bad',column:'workspace',type:'numeric'}]}]) {
    expect(mapped([bad])).toBeNull();
  }
  expect(mapped([source,source])).toBeNull();
});

test('mapped compiled source checks every column type, relation ownership and inactive RLS in the same synthetic database statement', () => {
  const q=compileAnalyticsSelect('SELECT currency, SUM(total) AS money, COUNT(DISTINCT site_id) AS accounts FROM bookings GROUP BY currency ORDER BY currency', undefined,mapped([source])!);
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
