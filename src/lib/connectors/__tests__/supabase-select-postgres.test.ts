import { spawnSync } from 'node:child_process';
import { compileAnalyticsSelect } from '../supabase-select-compiler';
import { siteA, siteB, testDataset } from './supabase-select-fixture';

// Execute the exact SQL and bind strings the real compiler emits, against a disposable in-memory
// PostgreSQL engine. PGlite's ESM/WASM loader runs outside Jest's VM; no network, env or credentials.
test('Postgres scopes before aggregation (incl joins), preserves precision, wire types/order/limits, and fails closed', () => {
  const a = testDataset({ workspace: siteA }), b = testDataset({ workspace: siteB }), global = testDataset({ global: true });
  const mixed = `SELECT s.currency bucket, COUNT(DISTINCT s.site_id) AS offices, SUM(s.amount) total,
    AVG(s.amount) mean, COUNT(*) AS items FROM analytics.sales AS s
    WHERE (s.amount > $1 OR s.paid = $2) AND s.sale_date >= DATE '2026-01-01'
    GROUP BY bucket ORDER BY total DESC LIMIT 2;`;
  const plans = {
    a: compileAnalyticsSelect(mixed, ['2.01', true], a),
    b: compileAnalyticsSelect(mixed, ['2.01', true], b),
    global: compileAnalyticsSelect(mixed, ['2.01', true], global),
    empty: compileAnalyticsSelect(mixed, ['99999999999999999999.99', false], b),
    emptyUngrouped: compileAnalyticsSelect(`select min(units), count(*) from sales where currency = $1`, ['CHF'], a),
    temporal: compileAnalyticsSelect(`select paid as settled, min(sale_date) first_day, max(created_at) last_at, sum(units) units
      from sales where created_at >= timestamptz '2026-01-01T00:00:00Z' group by paid order by settled desc`, undefined, a),
    nullOnly: compileAnalyticsSelect(`select sum(amount) missing, count(*) n from sales where amount is null and currency = 'CAD'`, undefined, a),
    nestedA: compileAnalyticsSelect(`select max(net) from analytics.baskets where currency = 'USD'`, undefined, a),
    nestedB: compileAnalyticsSelect(`select max(net) from analytics.baskets where currency = 'USD'`, undefined, b),
    nestedGlobal: compileAnalyticsSelect(`select count(*) from analytics.baskets`, undefined, global),
    rawA: compileAnalyticsSelect('select currency unit, amount, paid from sales where currency = $1 order by amount desc limit 1', ['USD'], a),
    rawB: compileAnalyticsSelect('select currency unit, amount, paid from sales where currency = $1 order by amount desc limit 1', ['USD'], b),
    rawPage: compileAnalyticsSelect('select units from sales where units >= 20 order by units', undefined, a),
    counts: compileAnalyticsSelect('select count(*) from sales', undefined, a),
    fixedUnit: compileAnalyticsSelect('select sum(amount) from sales where currency = $1 and (paid = true or units = 1)', ['USD'], a),
    nullCurrency: compileAnalyticsSelect('select currency unit, sum(amount), min(amount), count(*) from sales where currency is null group by unit', undefined, a),
    bounded: compileAnalyticsSelect('select units, count(*) from sales group by units order by units desc', undefined, a),
    oversize: compileAnalyticsSelect('select currency, count(*) from sales group by currency', undefined, b),
  };
  const script = `
    import { PGlite } from '@electric-sql/pglite';
    import assert from 'node:assert/strict';
    const db = new PGlite();
    const plans = ${JSON.stringify(plans)};
    const frame = async p => {
      const r = await db.query(p.query, p.parameters);
      assert.equal(r.rows.length, 1); return r.rows[0];
    };
    const rows = async key => {
      const p = plans[key], f = await frame(p);
      assert.deepEqual(Object.keys(f).sort(), ['analytics_rows', 'analytics_scope']);
      assert.equal(f.analytics_scope, p.attestation); return f.analytics_rows;
    };
    const deny = async () => assert.deepEqual(await frame(plans.a), {analytics_scope:null, analytics_rows:null});
    try {
      await db.exec(\`
        CREATE ROLE supabase_read_only_user;
        CREATE TABLE public.test_sales(site_id uuid, sale_date date, created_at timestamptz, currency text, amount numeric, units bigint, paid boolean);
        CREATE TABLE public.test_fees(site_id uuid, currency text, fee numeric);
        INSERT INTO public.test_sales VALUES
          ('${siteA}','2026-02-01','2026-02-01T01:02:03Z','USD',9007199254740993.91,11,true),
          ('${siteA}','2026-02-02','2026-02-02T01:02:03.045678+02:00','USD',0.10,10,true),
          ('${siteA}','2026-02-02','2026-02-02T00:00:00Z','EUR',3.00,2,false),
          ('${siteA}','2026-02-02','2026-02-02T00:01:00Z','CAD',null,4,false),
          ('${siteB}','2026-02-02','2026-02-02T00:00:00Z','USD',77.92,11,true);
        INSERT INTO public.test_fees VALUES ('${siteA}','USD',0.02), ('${siteA}','EUR',0.01), ('${siteB}','USD',1.92);
        GRANT SELECT ON public.test_sales, public.test_fees TO supabase_read_only_user;
        SET TIME ZONE 'Pacific/Honolulu'; SET DATESTYLE TO ISO, DMY;
      \`);
      await deny(); // Superuser is not the approved reporting role.
      await db.exec('SET ROLE supabase_read_only_user');
      const aw = await rows('a'), bw = await rows('b'), gw = await rows('global');
      assert.deepEqual(aw.map(({bucket,total,offices,items})=>[bucket,total,offices,items]),
        [['USD','9007199254740994.01','1','2'],['EUR','3.00','1','1']]);
      assert.match(aw[0].mean, /^4503599627370497\\.0050*$/);
      assert.deepEqual(bw.map(({bucket,total,offices})=>[bucket,total,offices]), [['USD','77.92','1']]);
      assert.deepEqual(gw.map(({bucket,total,offices})=>[bucket,total,offices]),
        [['USD','9007199254741071.93','2'],['EUR','3.00','1']]);
      assert.deepEqual(await rows('empty'), []);
      assert.deepEqual(await rows('fixedUnit'), [{sum:'9007199254740994.01'}]);
      assert.deepEqual(await rows('counts'), [{count:'4'}]); // Counts need no FX or currency grouping.
      assert.deepEqual(await rows('rawA'), [
        {unit:'USD',amount:'9007199254740993.91',paid:'true'}, {unit:'USD',amount:'0.10',paid:'true'},
      ]); // The second row is the lookahead for LIMIT 1, not a row from a different workspace.
      assert.deepEqual(await rows('rawB'), [{unit:'USD',amount:'77.92',paid:'true'}]);
      assert.deepEqual(await rows('emptyUngrouped'), [{min:null, count:'0'}]);
      assert.deepEqual(await rows('nullOnly'), [{missing:null, n:'1'}]);
      assert.deepEqual(await rows('temporal'), [
        {settled:'true', first_day:'2026-02-01', last_at:'2026-02-01T23:02:03.045678Z', units:'21'},
        {settled:'false', first_day:'2026-02-02', last_at:'2026-02-02T00:01:00.000000Z', units:'6'},
      ]);
      assert.deepEqual(await rows('nestedA'), [{max:'9007199254740993.89'}]);
      assert.deepEqual(await rows('nestedB'), [{max:'76.00'}]);
      assert.deepEqual(await rows('nestedGlobal'), [{count:'4'}]);
      await db.exec(\`
        RESET ROLE;
        INSERT INTO public.test_sales(site_id,units,amount) SELECT '${siteA}', x, 3.33 FROM generate_series(1,50) x;
        INSERT INTO public.test_sales(site_id,currency) VALUES ('${siteB}',repeat('a',201));
        SET ROLE supabase_read_only_user;
      \`);
      const page = await rows('bounded');
      assert.equal(page.length, 26); assert.deepEqual(page.map(v=>v.units), Array.from({length:26},(_,i)=>String(50-i)));
      assert.deepEqual(await rows('rawPage'), Array.from({length:26},(_,i)=>({units:String(20+i)})));
      assert.deepEqual(await rows('nullCurrency'), [{unit:null,sum:null,min:null,count:'50'}]);
      assert.deepEqual(await rows('oversize'), [{currency:'USD',count:'1'}, null]);
      await db.exec('RESET ROLE; ALTER TABLE public.test_sales ENABLE ROW LEVEL SECURITY; SET ROLE supabase_read_only_user');
      await deny(); // Active RLS is not the same thing as a verified empty aggregate.
    } finally { await db.close(); }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-'], { input: script, encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0) throw new Error(result.stderr?.slice(-2400) || 'Local SELECT compiler SQL verification failed');
}, 35_000);
