import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { setup, id, rows, one, scalar, asRole, addItem, search, claim, complete, revision, revisionToken, drain, embedding, model, migrationSql } from './catalog-search-sql-harness.mjs';

let db;
before(async () => { db = await setup(); });
after(async () => { await db?.close(); });

test('prebackfill source rows are immediately lexical, with no source rewrite', async () => {
  const original = await one(db, 'SELECT * FROM catalog_items WHERE id=$1', [id(10)]);
  assert.equal((await search(db, 'LEGACY'))[0].id, id(10));
  assert.equal(await scalar(db, 'SELECT count(*) FROM catalog_search_documents'), 0);
  const backfill = await asRole(db, 'service_role', () => rows(db, 'SELECT * FROM backfill_catalog_search(NULL,1,$1)', [id(1)]));
  assert.deepEqual(backfill, [{ catalog_item_id: id(10) }]);
  assert.deepEqual(await one(db, 'SELECT * FROM catalog_items WHERE id=$1', [id(10)]), original);
  const rev = await revision(db);
  await asRole(db, 'service_role', () => rows(db, 'SELECT * FROM backfill_catalog_search(NULL,1,$1)', [id(1)]));
  assert.equal(await revision(db), rev);
});

test('new docs are lexical before embeddings; exact SKU/name, FTS, literal substring, real trigram', async () => {
  await addItem(db, 20, { name: 'Precision screwdriver', sku: 'SCREW-20', description: 'Professional carpentry equipment' });
  await addItem(db, 21, { name: 'Discount 20%_literal', sku: 'LITERAL' });
  await addItem(db, 22, { name: 'Discount 20ABliteral' });
  assert.equal((await search(db, 'screw-20'))[0].exact_match, true);
  assert.equal((await search(db, 'Precision screwdriver'))[0].id, id(20));
  assert.ok((await search(db, 'carpentry professional')).some(r => r.id === id(20)));
  assert.ok((await search(db, 'screwdrivr')).some(r => r.id === id(20)));
  assert.deepEqual((await search(db, '%_')).map(r => r.id), [id(21)]);
  assert.equal((await search(db, '   ')).length, 0);
  assert.equal((await search(db, 'carpentry', { mode: 'semantic', vector: embedding })).length, 0);
});

test('catalog retrieval needs no extension SET privileges and uses its explicit text threshold', async () => {
  const configuration = await scalar(db, `SELECT proconfig FROM pg_proc
    WHERE oid='public.catalog_search_candidates(uuid,text,text,jsonb,text,double precision[],integer,double precision)'::regprocedure`);
  assert.ok(!configuration.some(value => /pg_trgm\.word_similarity_threshold|hnsw\.ef_search/.test(value)));
  await db.exec("SET pg_trgm.word_similarity_threshold = '0.99'");
  try {
    assert.ok((await search(db, 'screwdrivr')).some(row => row.id === id(20)));
  } finally { await db.exec('RESET pg_trgm.word_similarity_threshold'); }
});

test('forward migration removes legacy function GUCs and preserves grants/security', async () => {
  const signature = 'public.catalog_search_candidates(uuid,text,text,jsonb,text,double precision[],integer,double precision)';
  const definition = await scalar(db, 'SELECT pg_get_functiondef($1::regprocedure)', [signature]);
  const legacy = definition.replace(/(SET search_path TO [^\n]+\n)/,
    '$1SET "pg_trgm.word_similarity_threshold" TO \'0.5\'\nSET "hnsw.ef_search" TO \'200\'\n')
    .replace('word_similarity(v_query, d.document_text) >= 0.5', 'd.document_text %> v_query');
  assert.notEqual(legacy, definition);
  await db.exec(legacy);
  await db.exec(migrationSql(5));
  const repaired = await one(db, 'SELECT proconfig,prosecdef,proacl::text AS acl FROM pg_proc WHERE oid=$1::regprocedure', [signature]);
  assert.equal(repaired.prosecdef, true);
  assert.ok(repaired.proconfig.some(value => value.startsWith('search_path=')));
  assert.ok(!repaired.proconfig.some(value => /pg_trgm\.word_similarity_threshold|hnsw\.ef_search/.test(value)));
  assert.ok(repaired.acl.includes('service_role'));
  assert.ok((await search(db, 'screwdrivr')).some(row => row.id === id(20)));
});

test('safe projection: curated string attributes and same-site names only, stable hash/order/cap', async () => {
  const marker = randomUUID();
  await db.query('INSERT INTO catalog_categories(id,site_id,name) VALUES ($1,$2,$3),($4,$5,$6)',
    [id(40), id(1), 'String instruments', id(41), id(2), marker]);
  await db.query('INSERT INTO item_specs(id,site_id,name,metadata) VALUES ($1,$2,$3,$4),($5,$6,$7,$4)',
    [id(42), id(1), 'Cedarwood', { internal: marker }, id(43), id(2), marker]);
  await addItem(db, 30, { name: 'Classical guitar', category_id: id(40), cost: 7654321,
    target_sale_price: 9876543, metadata: { internal: marker, specs: [{ label: marker, value: marker }],
      stock: marker, attributes: { material: 'rosewood', color: { hidden: marker }, cost: marker, private: marker } } });
  await db.query('INSERT INTO catalog_item_specs VALUES ($1,$2,0),($1,$3,1)', [id(30), id(42), id(43)]);
  await drain(db);
  let doc = await one(db, 'SELECT * FROM catalog_search_documents WHERE catalog_item_id=$1', [id(30)]);
  assert.match(doc.document_text, /rosewood/);
  assert.match(doc.document_text, /Cedarwood/);
  assert.match(doc.document_text, /String instruments/);
  for (const excluded of [marker, '7654321', '9876543', 'hidden']) assert.ok(!doc.document_text.includes(excluded));
  assert.equal(doc.source_hash.length, 64);
  const previous = doc.source_revision;
  await db.query('UPDATE catalog_item_specs SET sort_order=99 WHERE catalog_item_id=$1', [id(30)]);
  assert.equal(await scalar(db, 'SELECT source_revision FROM catalog_search_documents WHERE catalog_item_id=$1', [id(30)]), previous);
  await db.query('UPDATE catalog_items SET description=$1 WHERE id=$2', ['長'.repeat(30000), id(30)]);
  doc = await one(db, 'SELECT document_text FROM catalog_search_documents WHERE catalog_item_id=$1', [id(30)]);
  assert.equal(doc.document_text.length, 6000);
});

test('source refreshes immediately; relationships drain durably; commerce only invalidates revisions', async () => {
  let rev = await revision(db);
  const sourceRev = await scalar(db, 'SELECT source_revision FROM catalog_search_documents WHERE catalog_item_id=$1', [id(30)]);
  await db.query('UPDATE catalog_items SET cost=10,target_sale_price=20,availability_status=$1 WHERE id=$2', ['sold_out', id(30)]);
  assert.ok(await revision(db) > rev);
  assert.equal(await scalar(db, 'SELECT source_revision FROM catalog_search_documents WHERE catalog_item_id=$1', [id(30)]), sourceRev);
  rev = await revision(db);
  await db.query('INSERT INTO inventory_levels VALUES ($1,$2,$3,5)', [id(50), id(1), id(30)]);
  await db.query('INSERT INTO price_lists VALUES ($1,$2,$3,$4,true)', [id(51), id(1), 'Retail', 'USD']);
  await db.query('INSERT INTO price_list_items VALUES ($1,$2,$3,$4,99)', [id(52), id(1), id(30), id(51)]);
  assert.equal(await revision(db), rev + 3n);
  assert.equal(await scalar(db, 'SELECT source_revision FROM catalog_search_documents WHERE catalog_item_id=$1', [id(30)]), sourceRev);
  await db.query('UPDATE catalog_categories SET name=$1 WHERE id=$2', ['Acoustic range', id(40)]);
  await db.query('UPDATE item_specs SET name=$1 WHERE id=$2', ['Sprucewood', id(42)]);
  await drain(db);
  assert.ok((await search(db, 'Sprucewood', { channel: 'catalog' })).some(r => r.id === id(30)));
  assert.ok((await search(db, 'Acoustic', { channel: 'catalog' })).some(r => r.id === id(30)));
  await db.query('DELETE FROM catalog_item_specs WHERE catalog_item_id=$1 AND item_spec_id=$2', [id(30), id(42)]);
  await drain(db);
  assert.equal((await search(db, 'Sprucewood', { channel: 'catalog' })).length, 0);
});

test('channel/site eligibility, parent fencing, archival overrides and null/variant filters', async () => {
  await addItem(db, 60, { name: 'Eligibility parent' });
  await addItem(db, 61, { name: 'Eligibility variant', parent_id: id(60) });
  await addItem(db, 62, { name: 'Eligibility archived', status: 'archived' });
  await addItem(db, 63, { name: 'Eligibility unlisted', is_marketplace_listed: false });
  await addItem(db, 64, { name: 'Eligibility soldout', availability_mode: 'inventory', availability_status: 'sold_out' });
  await addItem(db, 65, { name: 'Eligibility manual', availability_status: 'unavailable' });
  await addItem(db, 66, { name: 'Eligibility foreign', site_id: id(2) });
  await addItem(db, 67, { name: 'Eligibility crossparent', parent_id: id(66) });
  await addItem(db, 68, { name: 'Eligibility nopos', is_pos_available: false });
  const ids = async opts => (await search(db, 'Eligibility', opts)).map(r => r.id).sort();
  assert.deepEqual(await ids({ channel: 'shop' }), [60, 64, 68].map(id));
  assert.deepEqual(await ids({ channel: 'marketplace', site: null }), [60, 64, 66, 68].map(id));
  assert.deepEqual(await ids({ channel: 'catalog', filters: { status: 'archived' } }), [id(62)]);
  assert.ok((await ids({ channel: 'catalog' })).includes(id(62)));
  assert.deepEqual(await ids({ channel: 'catalog', filters: { kind: 'variant' } }), [61, 67].map(id));
  assert.ok(!(await ids({ filters: { category_id: null, parent_id: null } })).includes(id(61)));
  assert.ok(!(await ids({})).includes(id(67)));
  assert.ok((await ids({ channel: 'pos' })).includes(id(61)));
  assert.ok(!(await ids({ channel: 'pos' })).includes(id(68)));
  await db.query('UPDATE catalog_items SET is_pos_available=NULL WHERE id=$1', [id(68)]);
  assert.ok((await ids({ channel: 'pos' })).includes(id(68)));
  await db.query('UPDATE catalog_items SET status=$1 WHERE id=$2', ['archived', id(60)]);
  assert.ok(!(await ids({})).includes(id(61)));
  assert.ok(!(await ids({ channel: 'pos' })).includes(id(61)));
  await db.query('UPDATE sites SET archived_at=now() WHERE id=$1', [id(2)]);
  assert.ok(!(await ids({ channel: 'marketplace', site: null })).includes(id(66)));
  await db.query('UPDATE sites SET archived_at=NULL WHERE id=$1', [id(2)]);
  const visible = await asRole(db, 'service_role', () => rows(db,
    'SELECT * FROM catalog_search_visible_ids($1,$2,$3,$4)', [[id(61), id(62), id(63), id(66)], id(1), 'shop', {}]));
  assert.deepEqual(visible, []);
});

test('invalid scope, bounds, mode, filter keys/types and malformed vectors fail closed', async () => {
  for (const options of [{ site: null }, { channel: 'bad' }, { limit: 202 }, { limit: 0 }, { mode: 'bad' },
    { filters: { metadata: 'private' } }, { filters: { status: ['active'] } }, { filters: { is_purchasable: 'true' } },
    { filters: { category_id: 'invalid' } }, { filters: { currency: 'usd' } },
    { minSimilarity: -1 }, { minSimilarity: 2 }, { minSimilarity: null },
    { mode: 'semantic', vector: [1, 2] }, { mode: 'semantic', vector: Array(1536).fill(0) }]) {
    await assert.rejects(search(db, 'guitar', options));
  }
  await assert.rejects(search(db, 'x'.repeat(1001)));
  await assert.rejects(asRole(db, 'service_role', () => rows(db, 'SELECT * FROM claim_catalog_embedding_jobs(101,180)')));
  await assert.rejects(asRole(db, 'service_role', () => rows(db, 'SELECT * FROM claim_catalog_embedding_jobs(1,1)')));
});

test('leases exclude duplicate work; expired claims, tokens, revision/hash and rapid ABA updates are fenced', async () => {
  const jobs = await claim(db);
  assert.ok(jobs.length >= 1);
  assert.equal((await claim(db)).length, 0);
  const job = jobs.find(j => j.catalog_item_id === id(20));
  assert.ok(job);
  assert.equal(await complete(db, job, { claim_token: randomUUID() }), false);
  assert.equal(await complete(db, job, { source_hash: 'wrong' }), false);
  assert.equal(await complete(db, job, { source_revision: Number(job.source_revision) + 1 }), false);
  await db.query('UPDATE catalog_embedding_jobs SET lease_expires_at=now()-interval \'1 second\' WHERE id=$1', [job.id]);
  assert.equal(await complete(db, job), false);
  const reclaimed = (await claim(db))[0];
  assert.equal(reclaimed.id, job.id);
  assert.notEqual(reclaimed.claim_token, job.claim_token);
  assert.equal(await complete(db, job), false);
  const rev = await revision(db);
  assert.equal(await complete(db, reclaimed), true);
  assert.equal(await revision(db), rev + 1n);
  assert.equal(await complete(db, reclaimed), false);
  assert.ok((await search(db, 'screwdriver', { mode: 'semantic', vector: embedding })).some(r => r.id === id(20)));
  await db.query('UPDATE catalog_items SET name=$1 WHERE id=$2', ['Changed screwdriver', id(20)]);
  const mid = (await claim(db))[0];
  await db.query('UPDATE catalog_items SET name=$1 WHERE id=$2', ['Precision screwdriver', id(20)]);
  assert.equal(await complete(db, mid), false);
  assert.equal(await complete(db, reclaimed), false);
  assert.ok(!(await search(db, 'screwdriver', { mode: 'semantic', vector: embedding })).some(r => r.id === id(20)));
  const latest = (await claim(db))[0];
  assert.ok(Number(latest.source_revision) > Number(reclaimed.source_revision));
  assert.equal(latest.source_hash, reclaimed.source_hash);
  await assert.rejects(complete(db, latest, { model: 'different/model' }));
  assert.equal(await complete(db, latest), true);
});

test('failures are durable, sanitized, delayed and fenced; stale model/hash excluded', async () => {
  await addItem(db, 80, { name: 'Retry item' });
  const job = (await claim(db)).find(j => j.catalog_item_id === id(80));
  const marker = randomUUID();
  const fail = (token) => asRole(db, 'service_role', () => scalar(db,
    'SELECT fail_catalog_embedding_job($1,$2,$3)', [job.id, token, marker]));
  assert.equal(await fail(randomUUID()), false);
  assert.equal(await fail(job.claim_token), true);
  assert.equal(await fail(job.claim_token), false);
  let state = await one(db, 'SELECT * FROM catalog_embedding_jobs WHERE id=$1', [job.id]);
  assert.equal(state.status, 'retry');
  assert.equal(state.last_error, 'embedding_failed');
  assert.ok(!JSON.stringify(state).includes(marker));
  assert.equal((await claim(db)).length, 0);
  await db.query('UPDATE catalog_embedding_jobs SET next_attempt_at=now()-interval \'1 second\' WHERE id=$1', [job.id]);
  const retry = (await claim(db))[0];
  assert.equal(await complete(db, retry), true);
  await db.query('UPDATE catalog_search_documents SET embedding_model=$1 WHERE catalog_item_id=$2', ['legacy/model', id(80)]);
  assert.ok(!(await search(db, 'Retry', { mode: 'semantic', vector: embedding })).some(r => r.id === id(80)));
  await db.query('UPDATE catalog_search_documents SET embedding_model=$1,embedding_source_hash=$2 WHERE catalog_item_id=$3', [model, 'stale', id(80)]);
  assert.ok(!(await search(db, 'Retry', { mode: 'semantic', vector: embedding })).some(r => r.id === id(80)));
});

test('backfill cursor is lexical UUID bounded and idempotent; deletion cascades queue/doc', async () => {
  const page = await asRole(db, 'service_role', () => rows(db, 'SELECT * FROM backfill_catalog_search($1,2,$2)', [id(20), id(1)]));
  assert.deepEqual(page.map(r => r.catalog_item_id), [id(21), id(22)]);
  const original = await rows(db, 'SELECT id,name,updated_at FROM catalog_items ORDER BY id');
  await asRole(db, 'service_role', () => rows(db, 'SELECT * FROM backfill_catalog_search(NULL,500,NULL)'));
  assert.deepEqual(await rows(db, 'SELECT id,name,updated_at FROM catalog_items ORDER BY id'), original);
  const rev = await revision(db);
  await db.query('DELETE FROM catalog_items WHERE id=$1', [id(80)]);
  assert.equal(await scalar(db, 'SELECT count(*) FROM catalog_search_documents WHERE catalog_item_id=$1', [id(80)]), 0);
  assert.equal(await scalar(db, 'SELECT count(*) FROM catalog_embedding_jobs WHERE catalog_item_id=$1', [id(80)]), 0);
  assert.ok(await revision(db) > rev);
});

test('semantic threshold rejects unrelated nearest vectors; candidate and visible bounds are enforced', async () => {
  await addItem(db, 90, { name: 'Orthogonal semantic test' });
  const job = (await claim(db)).find(j => j.catalog_item_id === id(90));
  const orthogonal = Array.from({ length: 1536 }, (_, i) => i === 1 ? 1 : 0);
  assert.equal(await complete(db, job, { embedding: orthogonal }), true);
  assert.ok(!(await search(db, 'unrelated', { mode: 'semantic', vector: embedding })).some(r => r.id === id(90)));
  assert.ok((await search(db, 'related', { mode: 'semantic', vector: orthogonal })).some(r => r.id === id(90)));
  assert.ok((await search(db, 'threshold override', { mode: 'semantic', vector: embedding, minSimilarity: 0 })).some(r => r.id === id(90)));
  assert.ok((await search(db, 'guitar', { limit: 1 })).length <= 1);
  assert.ok((await search(db, 'related', { mode: 'semantic', vector: orthogonal, limit: 1 })).length <= 1);
  await assert.rejects(asRole(db, 'service_role', () => rows(db,
    'SELECT * FROM catalog_search_visible_ids($1,$2,$3,$4)', [Array(401).fill(id(90)), id(1), 'tools', {}])));
});

test('explicit failures and crashed-worker leases exhaust at eight attempts; explicit backfill repairs', async () => {
  await addItem(db, 91, { name: 'Exhaustion explicit' });
  let job = (await claim(db)).find(j => j.catalog_item_id === id(91));
  await db.query('UPDATE catalog_embedding_jobs SET attempts=8 WHERE id=$1', [job.id]);
  assert.equal(await asRole(db, 'service_role', () => scalar(db, 'SELECT fail_catalog_embedding_job($1,$2,$3)',
    [job.id, job.claim_token, 'timeout'])), true);
  assert.equal(await scalar(db, 'SELECT status FROM catalog_embedding_jobs WHERE id=$1', [job.id]), 'exhausted');
  assert.ok(!(await claim(db)).some(j => j.id === job.id));
  const sourceRev = job.source_revision;
  await asRole(db, 'service_role', () => rows(db, 'SELECT * FROM backfill_catalog_search($1,1,$2)', [id(90), id(1)]));
  job = (await claim(db)).find(j => j.catalog_item_id === id(91));
  assert.equal(job.source_revision, sourceRev);
  assert.equal(await scalar(db, 'SELECT attempts FROM catalog_embedding_jobs WHERE id=$1', [job.id]), 1);
  await db.query('UPDATE catalog_embedding_jobs SET attempts=8,lease_expires_at=now()-interval \'1 second\' WHERE id=$1', [job.id]);
  assert.ok(!(await claim(db)).some(j => j.id === job.id));
  assert.equal(await scalar(db, 'SELECT status FROM catalog_embedding_jobs WHERE id=$1', [job.id]), 'exhausted');
  assert.equal(await complete(db, job), false);
  await db.query('UPDATE catalog_items SET name=$1 WHERE id=$2', ['Exhaustion renewed source', id(91)]);
  assert.ok((await claim(db)).some(j => j.catalog_item_id === id(91)));
});

test('relationship reassignment/deletion, site movement and rollback leave no stale publication', async () => {
  await db.query('INSERT INTO item_specs(id,site_id,name) VALUES ($1,$2,$3)', [id(92), id(1), 'Renameable specification']);
  await addItem(db, 93, { name: 'Relationship first' });
  await addItem(db, 94, { name: 'Relationship second' });
  await db.query('INSERT INTO catalog_item_specs VALUES ($1,$2,0)', [id(93), id(92)]);
  await drain(db);
  assert.ok((await search(db, 'Renameable')).some(r => r.id === id(93)));
  await db.query('UPDATE catalog_item_specs SET catalog_item_id=$1 WHERE catalog_item_id=$2', [id(94), id(93)]);
  await drain(db);
  assert.deepEqual((await search(db, 'Renameable')).map(r => r.id), [id(94)]);
  await db.query('DELETE FROM item_specs WHERE id=$1', [id(92)]);
  await drain(db);
  assert.equal((await search(db, 'Renameable')).length, 0);
  const job = (await claim(db)).find(j => j.catalog_item_id === id(94));
  const oldRev = await revision(db, id(1));
  const newRev = await revision(db, id(2));
  await db.query('UPDATE catalog_items SET site_id=$1 WHERE id=$2', [id(2), id(94)]);
  assert.ok(await revision(db, id(1)) > oldRev);
  assert.ok(await revision(db, id(2)) > newRev);
  assert.equal(await complete(db, job), false);
  assert.ok(!(await search(db, 'Relationship')).some(r => r.id === id(94)));
  assert.ok((await search(db, 'Relationship', { site: id(2) })).some(r => r.id === id(94)));
  const before = await one(db, 'SELECT * FROM catalog_search_documents WHERE catalog_item_id=$1', [id(93)]);
  const rev = await revision(db);
  await db.exec('BEGIN');
  await db.query('UPDATE catalog_items SET name=$1 WHERE id=$2', ['Rolled back name', id(93)]);
  await db.exec('ROLLBACK');
  assert.deepEqual(await one(db, 'SELECT * FROM catalog_search_documents WHERE catalog_item_id=$1', [id(93)]), before);
  assert.equal(await revision(db), rev);
});

test('ACLs defeat Supabase default grants: no client tables/functions, service API only, fixed search_path', async () => {
  const functions = await rows(db, `SELECT oid::regprocedure::text signature, proname, proconfig FROM pg_proc
    WHERE pronamespace='public'::regnamespace AND (proname LIKE '%catalog_search%' OR proname LIKE '%catalog_embedding%')`);
  for (const f of functions) {
    assert.ok(f.proconfig.some(c => c.startsWith('search_path=')), f.signature);
    for (const role of ['anon', 'authenticated']) {
      assert.equal(await scalar(db, 'SELECT has_function_privilege($1,$2,\'EXECUTE\')', [role, f.signature]), false, f.signature);
    }
  }
  for (const role of ['anon', 'authenticated']) {
    for (const table of ['catalog_search_documents', 'catalog_embedding_jobs', 'catalog_search_revisions', 'catalog_search_revision_events', 'catalog_search_refresh_events']) {
      await assert.rejects(asRole(db, role, () => rows(db, `SELECT * FROM ${table}`)));
    }
    await assert.rejects(asRole(db, role, () => rows(db, 'SELECT * FROM catalog_search_candidates($1,\'catalog\',\'guitar\',\'{}\',\'text\',NULL,10)', [id(1)])));
    await assert.rejects(asRole(db, role, () => rows(db, 'SELECT * FROM claim_catalog_embedding_jobs(1,180)')));
    await assert.rejects(asRole(db, role, () => rows(db, 'SELECT refresh_catalog_search_document($1)', [id(20)])));
  }
  await assert.rejects(asRole(db, 'service_role', () => rows(db, 'SELECT * FROM catalog_search_documents')));
  await assert.rejects(asRole(db, 'service_role', () => rows(db, 'UPDATE catalog_embedding_jobs SET status=\'pending\'')));
  await assert.rejects(asRole(db, 'service_role', () => rows(db, 'SELECT refresh_catalog_search_document($1)', [id(20)])));
  await assert.rejects(asRole(db, 'service_role', () => rows(db, 'SELECT * FROM catalog_search_revisions')));
  assert.match(await revisionToken(db), /^events-v1:\d+:\d+$/);
});

test('full Unicode lexical names and SKUs have byte-bounded equality indexes', async () => {
  const longName = Array.from({ length: 1000 }, (_, n) => String.fromCodePoint(0x4e00 + n)).join('');
  assert.equal(Buffer.byteLength(longName), 3000);
  await addItem(db, 110, { name: longName, sku: 'UNICODE-110' });
  assert.equal(await scalar(db, 'SELECT name_text FROM catalog_search_documents WHERE catalog_item_id=$1', [id(110)]), longName);
  assert.equal((await search(db, longName))[0].exact_match, true);
  await addItem(db, 111, { name: longName.repeat(5), sku: longName });
  assert.equal(await scalar(db, 'SELECT length(name_text) FROM catalog_search_documents WHERE catalog_item_id=$1', [id(111)]), 5000);
  assert.ok((await search(db, longName)).some(r => r.id === id(111) && r.exact_match));
  const indexes = await rows(db, `SELECT indexdef FROM pg_indexes WHERE indexname IN
    ('catalog_search_documents_name_idx','catalog_search_documents_sku_idx')`);
  assert.equal(indexes.length, 2);
  for (const index of indexes) assert.match(index.indexdef, /md5\(lower\(/);
});

test('ambiguous semantic labels still refresh lexical fields and fence old embeddings', async () => {
  await addItem(db, 112, { name: 'X SKU: Y', sku: null });
  const original = await one(db, 'SELECT * FROM catalog_search_documents WHERE catalog_item_id=$1', [id(112)]);
  assert.equal(original.source_hash, await scalar(db, `SELECT encode(sha256(convert_to(
    jsonb_build_array('source-v2-byte7000',name_text,sku_text,document_text)::text,'UTF8')),'hex')
    FROM catalog_search_documents WHERE catalog_item_id=$1`, [id(112)]));
  const job = (await claim(db)).find(j => j.catalog_item_id === id(112));
  assert.equal(await complete(db, job), true);
  await db.query('UPDATE catalog_items SET name=$1,sku=$2 WHERE id=$3', ['X', 'Y', id(112)]);
  const updated = await one(db, 'SELECT * FROM catalog_search_documents WHERE catalog_item_id=$1', [id(112)]);
  assert.equal(updated.document_text, original.document_text);
  assert.notEqual(updated.source_hash, original.source_hash);
  assert.equal(updated.sku_text, 'Y');
  assert.equal(updated.embedding, null);
  assert.ok((await search(db, 'Y')).some(r => r.id === id(112) && r.exact_match));
  assert.equal(await complete(db, job), false);
});

test('tools and POS product kind include variant SKU; catalog and storefront retain own parent policies', async () => {
  await addItem(db, 113, { name: 'Variant policy parent' });
  await addItem(db, 114, { name: 'Variant policy child', sku: 'CHILD-EXACT', parent_id: id(113), kind: 'product' });
  for (const channel of ['tools', 'pos']) {
    assert.equal((await search(db, 'CHILD-EXACT', { channel, filters: { kind: 'product' } }))[0].id, id(114));
    const visible = await asRole(db, 'service_role', () => rows(db,
      'SELECT * FROM catalog_search_visible_ids($1,$2,$3,$4)', [[id(114)], id(1), channel, { kind: 'product' }]));
    assert.deepEqual(visible.map(r => r.id), [id(114)]);
  }
  for (const channel of ['catalog', 'shop', 'marketplace'])
    assert.deepEqual(await search(db, 'CHILD-EXACT', { channel, filters: { kind: 'product' } }), []);
});

test('revision events are transactional and detect an older ID becoming visible after a newer ID', async () => {
  const before = await revisionToken(db);
  const reserved = await scalar(db, "SELECT nextval('catalog_search_revision_events_id_seq')");
  await db.query('SELECT catalog_search_bump_revision($1)', [id(1)]);
  const newer = await revisionToken(db);
  // Single-session model of reverse commit. True reverse commit is in local PG suite.
  await db.query('INSERT INTO catalog_search_revision_events(id,site_id) OVERRIDING SYSTEM VALUE VALUES ($1,$2)', [reserved, id(1)]);
  const older = await revisionToken(db);
  assert.notEqual(before, newer);
  assert.notEqual(newer, older);
  assert.equal(newer.split(':')[2], older.split(':')[2]);
  const beforeRollback = await revisionToken(db);
  await db.exec('BEGIN');
  await db.query('SELECT catalog_search_bump_revision($1)', [id(1)]);
  await db.exec('ROLLBACK');
  assert.equal(await revisionToken(db), beforeRollback);
  const functionBody = await scalar(db, "SELECT prosrc FROM pg_proc WHERE oid='catalog_search_bump_revision(uuid)'::regprocedure");
  assert.ok(!functionBody.includes('catalog_search_revisions'));
  assert.ok(!/UPDATE|FOR UPDATE|advisory/i.test(functionBody));
});

test('relationship refresh is append-only, rolled back atomically, and drained by unchanged worker RPC', async () => {
  await db.query('INSERT INTO catalog_categories(id,site_id,name) VALUES ($1,$2,$3)', [id(115), id(1), 'Beforefanout']);
  await addItem(db, 116, { category_id: id(115) });
  const rev = await revisionToken(db);
  await db.query('UPDATE catalog_categories SET name=$1 WHERE id=$2', ['Afterfanout', id(115)]);
  assert.notEqual(await revisionToken(db), rev);
  assert.ok(await scalar(db, 'SELECT count(*) FROM catalog_search_refresh_events') > 0);
  assert.ok(!(await search(db, 'Afterfanout')).some(r => r.id === id(116)));
  assert.ok((await claim(db)).some(j => j.catalog_item_id === id(116)));
  assert.ok((await search(db, 'Afterfanout')).some(r => r.id === id(116)));
  const pending = await scalar(db, 'SELECT count(*) FROM catalog_search_refresh_events');
  await db.exec('BEGIN');
  await db.query('UPDATE catalog_categories SET name=$1 WHERE id=$2', ['Rollbackfanout', id(115)]);
  await db.exec('ROLLBACK');
  assert.equal(await scalar(db, 'SELECT count(*) FROM catalog_search_refresh_events'), pending);
  assert.ok(!(await search(db, 'Rollbackfanout')).some(r => r.id === id(116)));
});

test('refresh batch progress and pending RPC cover unchanged fanout, without delayed retries or active leases', async () => {
  const pending = () => asRole(db, 'service_role', () => scalar(db, 'SELECT catalog_search_index_pending()'));
  const refreshBatch = limit => asRole(db, 'service_role', () => scalar(db, 'SELECT catalog_search_refresh_batch($1)', [limit]));
  await db.exec(`UPDATE catalog_embedding_jobs SET status='exhausted',claim_token=NULL,lease_expires_at=NULL;
    DELETE FROM catalog_search_refresh_events`);
  assert.equal(await pending(), false);
  await db.query(`INSERT INTO catalog_search_refresh_events(catalog_item_id)
    SELECT $1 FROM generate_series(1,150)`, [id(116)]);
  assert.equal(await pending(), true);
  assert.equal(await refreshBatch(100), 100);
  assert.equal(await pending(), true);
  assert.equal(await refreshBatch(100), 50);
  assert.equal(await pending(), false);
  await db.query(`UPDATE catalog_embedding_jobs SET status='retry',attempts=1,next_attempt_at=now()+interval '1 hour' WHERE catalog_item_id=$1`, [id(116)]);
  assert.equal(await pending(), false);
  await db.query(`UPDATE catalog_embedding_jobs SET next_attempt_at=now()-interval '1 second' WHERE catalog_item_id=$1`, [id(116)]);
  assert.equal(await pending(), true);
  await claim(db);
  assert.equal(await pending(), false);
  await db.query(`UPDATE catalog_embedding_jobs SET lease_expires_at=now()-interval '1 second' WHERE catalog_item_id=$1`, [id(116)]);
  assert.equal(await pending(), true);
  await assert.rejects(refreshBatch(101));
  for (const role of ['anon','authenticated']) {
    await assert.rejects(asRole(db, role, () => scalar(db, 'SELECT catalog_search_refresh_batch(1)')));
    await assert.rejects(asRole(db, role, () => scalar(db, 'SELECT catalog_search_index_pending()')));
  }
});