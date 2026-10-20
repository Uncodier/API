import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { setup, scalar, one, asRole, search, migrationSql } from './catalog-search-sql-harness.mjs';

const signature = 'public.catalog_search_candidates(uuid,text,text,jsonb,text,double precision[],integer,double precision)';
const functionDefinition = db => scalar(db, 'SELECT pg_get_functiondef($1::regprocedure)', [signature]);
const state = db => one(db, `SELECT oid,proowner,proacl::text AS acl,prosecdef,provolatile,proconfig,
  pronargs,proargnames,proargtypes::text,proallargtypes::text,proargmodes,pg_get_expr(proargdefaults,0) AS defaults
  FROM pg_proc WHERE oid=$1::regprocedure`, [signature]);
const lexical = definition => definition.slice(definition.indexOf('  ELSE\n    v_pattern'));

test('107 changes only unique semantic SQL, retaining signature/default/DTO, grants, security and no extension SET', async () => {
  const db = await setup({ through: 6 });
  try {
    const before = await functionDefinition(db);
    const metadata = await state(db);
    await db.exec(migrationSql(7));
    const after = await functionDefinition(db);
    assert.notEqual(after, before);
    assert.deepEqual(await state(db), metadata);
    assert.ok(lexical(before).length > 1000);
    assert.equal(lexical(after), lexical(before));
    assert.equal(after.slice(0, after.indexOf('    RETURN QUERY')), before.slice(0, before.indexOf('    RETURN QUERY')));
    assert.ok(after.includes('WITH eligible AS MATERIALIZED'));
    assert.ok(after.indexOf('public.catalog_search_eligible') < after.indexOf('FROM eligible e'));
    assert.ok(after.includes('ORDER BY distance, e.catalog_item_id LIMIT p_limit'));
    assert.ok(!after.includes('LIMIT least(p_limit * 4, 800)'));
    assert.ok(!/SET\s+"?(?:hnsw|pg_trgm)\./i.test(after));
    assert.ok(!metadata.proconfig.some(value => /hnsw\.|pg_trgm\./.test(value)));
    assert.equal(metadata.pronargs, 8);
    assert.equal(Number(metadata.defaults), 0.35);
    assert.deepEqual(metadata.proargnames.slice(-4), ['id','site_id','score','exact_match']);
    await db.exec(migrationSql(7));
    assert.equal(await functionDefinition(db), after);
    for (const role of ['anon','authenticated']) {
      assert.equal(await scalar(db, 'SELECT has_function_privilege($1,$2,\'EXECUTE\')', [role,signature]), false);
      await assert.rejects(asRole(db, role, () => scalar(db, 'SELECT count(*) FROM catalog_search_documents')));
    }
    assert.equal(await scalar(db, 'SELECT has_function_privilege(\'service_role\',$1,\'EXECUTE\')', [signature]), true);
    await assert.rejects(asRole(db, 'service_role', () => scalar(db, 'SELECT count(*) FROM catalog_search_documents')));
    for (const minSimilarity of [-1, 1.01, null, NaN, Infinity]) await assert.rejects(search(db, 'intent', { minSimilarity }));
  } finally { await db.close(); }
});

test('107 fails closed for unknown/duplicate semantic SQL or missing 106 limit guard', async () => {
  const db = await setup({ through: 6 });
  try {
    const original = await functionDefinition(db);
    const oldStart = original.indexOf('    RETURN QUERY SELECT ranked.catalog_item_id');
    const oldEnd = original.indexOf('\n  ELSE', oldStart);
    const oldBranch = original.slice(oldStart, oldEnd);
    const variants = [
      original.replace('p_limit NOT BETWEEN 1 AND 201', 'p_limit NOT BETWEEN 1 AND 200'),
      original.replace('LIMIT least(p_limit * 4, 800)', 'LIMIT least(p_limit * 3, 800)'),
      original.replace(oldBranch, `${oldBranch}\n${oldBranch}`),
    ];
    for (const definition of variants) {
      await db.exec(definition);
      await assert.rejects(db.exec(migrationSql(7)), /Unexpected catalog/);
      await db.exec('ROLLBACK');
      assert.equal(await functionDefinition(db), definition);
    }
    await db.exec(original);
    await db.exec(migrationSql(7));
  } finally { await db.close(); }
});

test('exact filtered cosine recall: 104 eligible, 80 closer cross-site, 0.25 calibration, live eligibility before cap', async () => {
  const db = await setup();
  try {
    await db.exec(readFileSync(new URL('./catalog-search-semantic-recall-fixture.sql', import.meta.url), 'utf8'));
  } finally { await db.close(); }
});