import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup, id, search, scalar, one, embedding, model, migrationSql } from './catalog-search-sql-harness.mjs';

test('1500-row catalog is indexed transactionally and queried as a bounded candidate window', async () => {
  const db = await setup();
  try {
    await db.query(`INSERT INTO catalog_items(id,site_id,name,sku,description)
      SELECT ('20000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,$1,
        'Synthetic running shoe ' || n, 'RUN-' || n, 'Breathable daily running shoe'
      FROM generate_series(1,1500) n`, [id(1)]);
    assert.equal(await scalar(db, 'SELECT count(*)::int FROM catalog_search_documents'), 1500);
    const candidates = await search(db, 'running shoe');
    assert.equal(candidates.length, 200);
    assert.equal(new Set(candidates.map(row => row.id)).size, 200);
    const probe = await search(db, 'running shoe', { limit: 201 });
    assert.equal(probe.length, 201);
    assert.deepEqual(probe.slice(0, 200), candidates);
    const exact = await search(db, 'RUN-1500');
    assert.equal(exact[0].id, '20000000-0000-4000-8000-000000001500');
    assert.equal(exact[0].exact_match, true);
    assert.equal((await search(db, 'running shoe', { site: id(2) })).length, 0);
  } finally { await db.close(); }
});

test('forward overflow probe preserves SQL ownership/ACLs and distinguishes 199, 200 and 201 eligible candidates', async () => {
  const db = await setup();
  try {
    const signature = 'public.catalog_search_candidates(uuid,text,text,jsonb,text,double precision[],integer,double precision)';
    const definition = await scalar(db, 'SELECT pg_get_functiondef($1::regprocedure)', [signature]);
    // Reconstruct the already-installed 10500 state, then execute the unmodified forward repair.
    const legacy = definition.replace('p_limit NOT BETWEEN 1 AND 201', 'p_limit NOT BETWEEN 1 AND 200');
    assert.notEqual(legacy, definition);
    await db.exec(legacy);
    await assert.rejects(search(db, 'probe', { limit: 201 }));
    const state = () => one(db, `SELECT proowner,proacl::text AS acl,prosecdef,proconfig FROM pg_proc
      WHERE oid=$1::regprocedure`, [signature]);
    const before = await state();
    await db.exec(migrationSql(6));
    assert.deepEqual(await state(), before);
    assert.equal(await scalar(db, 'SELECT pg_get_functiondef($1::regprocedure)', [signature]), definition);
    await db.exec(migrationSql(6)); // Guarded and safe to retry in the isolated database.
    for (const limit of [0, 202, 1000]) await assert.rejects(search(db, 'probe', { limit }));

    const itemId = n => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    await db.query(`INSERT INTO catalog_items(id,site_id,name)
      SELECT ('30000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,$1,'Overflow probe shoes'
      FROM generate_series(1,199) n`, [id(1)]);
    const publish = () => db.query(`UPDATE catalog_search_documents SET embedding=$1,
      embedding_model=$2,embedding_source_hash=source_hash WHERE site_id=$3`, [embedding, model, id(1)]);
    const check = async expected => {
      await publish();
      for (const mode of ['text', 'semantic']) {
        const probe = await search(db, 'Overflow probe shoes', { mode, vector: embedding, limit: 201 });
        assert.equal(probe.length, expected, `${mode} probe must report real eligible rows`);
        assert.equal(new Set(probe.map(row => row.id)).size, expected);
        assert.deepEqual((await search(db, 'Overflow probe shoes', { mode, vector: embedding })), probe.slice(0, 200));
      }
    };
    await check(199);
    await db.query('INSERT INTO catalog_items(id,site_id,name) VALUES ($1,$2,$3)', [itemId(200), id(1), 'Overflow probe shoes']);
    await check(200);
    await db.query('INSERT INTO catalog_items(id,site_id,name) VALUES ($1,$2,$3)', [itemId(201), id(1), 'Overflow probe shoes']);
    await check(201);
    await db.query('UPDATE catalog_items SET status=$1 WHERE id=$2', ['archived', itemId(201)]);
    await check(200);
    assert.equal((await search(db, 'Overflow probe shoes', { limit: 201, site: id(2) })).length, 0);
    assert.equal((await search(db, 'Overflow probe shoes', { limit: 201, filters: { currency: 'EUR' } })).length, 0);
    await db.query('UPDATE catalog_search_documents SET embedding_source_hash=$1 WHERE catalog_item_id=$2', ['stale', itemId(200)]);
    assert.equal((await search(db, 'probe', { mode: 'semantic', vector: embedding, limit: 201 })).length, 199);
  } finally { await db.close(); }
});