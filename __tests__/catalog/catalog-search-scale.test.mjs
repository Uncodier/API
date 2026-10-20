import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup, id, search, scalar } from './catalog-search-sql-harness.mjs';

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
    const exact = await search(db, 'RUN-1500');
    assert.equal(exact[0].id, '20000000-0000-4000-8000-000000001500');
    assert.equal(exact[0].exact_match, true);
    assert.equal((await search(db, 'running shoe', { site: id(2) })).length, 0);
  } finally { await db.close(); }
});