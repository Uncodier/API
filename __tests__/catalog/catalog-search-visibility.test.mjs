import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';
import { setup, addItem, id, embedding, model } from './catalog-search-sql-harness.mjs';

const require = createRequire(import.meta.url);
const serviceRoot = new URL('../../src/lib/services/catalog-search/', import.meta.url);

/** Actual service code; transport/embedding/cache are offline, RPC predicates run real SQL. */
function loadService(boundaries) {
  const modules = new Map();
  function load(name) {
    if (boundaries[name]) return boundaries[name];
    if (!name.startsWith('.')) return require(name);
    if (modules.has(name)) return modules.get(name);
    const module = { exports: {} };
    const code = ts.transpileModule(readFileSync(new URL(`${name.slice(2)}.ts`, serviceRoot), 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    runInNewContext(`(function(require,module,exports){${code}\n})`, {
      AbortSignal, process: { env: { CATALOG_SEMANTIC_SEARCH_ENABLED: 'true' } }, console: { info() {} },
    })(load, module, module.exports);
    modules.set(name, module.exports);
    return module.exports;
  }
  return load('./service').searchCatalog;
}

test('service recovers a live-emptied first page with SQL-eligible related items and pins continuation', async () => {
  const db = await setup();
  try {
    await addItem(db, 8001, { name: 'Sandwich', sku: 'MEAL-A' });
    await addItem(db, 8002, { name: 'Roll', sku: 'MEAL-B' });
    await addItem(db, 8003, { name: 'Bun', sku: 'MEAL-C' });
    // Query unit vector gives cosine 0.30; no provider or real product text is used.
    const vector = [.3, Math.sqrt(.91), ...Array(1534).fill(0)];
    await db.query(`UPDATE catalog_search_documents SET embedding=$1,
      embedding_model=$2,embedding_source_hash=source_hash WHERE catalog_item_id IN ($3,$4)`,
    [vector, model, id(8002), id(8003)]);
    const thresholds = [];
    let changed = false;
    let embeddingCalls = 0;
    let snapshot;
    const cachedWindows = [];
    const rpc = (name, p) => ({ abortSignal: async () => {
      let data;
      if (name === 'catalog_search_revision') {
        data = (await db.query('SELECT catalog_search_revision($1) AS revision', [p.p_site_id])).rows[0].revision;
      } else if (name === 'catalog_search_candidates') {
        if (p.p_mode === 'semantic') thresholds.push(p.p_min_similarity);
        data = (await db.query('SELECT * FROM catalog_search_candidates($1,$2,$3,$4,$5,$6,$7,$8)',
          [p.p_site_id, p.p_channel, p.p_query, p.p_filters, p.p_mode,
            p.p_embedding ? JSON.parse(p.p_embedding) : null, p.p_limit, p.p_min_similarity])).rows;
      } else {
        assert.equal(name, 'catalog_search_visible_ids');
        if (!changed) {
          changed = true;
          await db.query("UPDATE catalog_items SET availability_status='unavailable' WHERE id=$1", [id(8001)]);
        }
        data = (await db.query('SELECT * FROM catalog_search_visible_ids($1,$2,$3,$4)',
          [p.p_ids, p.p_site_id, p.p_channel, p.p_filters])).rows;
      }
      return { data, error: null };
    } });
    const searchCatalog = loadService({
      '@/lib/database/supabase-client': { supabaseAdmin: { rpc } },
      './cache': { catalogCacheKey: (kind, value) => JSON.stringify([kind, value]),
        catalogSingleFlight: (_key, compute) => compute(), readCatalogCache: async () => null,
        writeCatalogCache: async (_key, value) => { cachedWindows.push(value); } },
      './query-embedding': { getCatalogQueryEmbedding: async () => { embeddingCalls++; return embedding; } },
      './snapshots': { readCatalogSnapshot: async () => snapshot,
        saveCatalogSnapshot: async (_id, value) => { snapshot = value; }, SNAPSHOT_LIFETIME_MS: 120000 },
    });
    const input = { query: 'sandwich', site_id: id(1), channel: 'shop', limit: 1,
      filters: { status: 'active', parent_id: null, is_marketplace_listed: true } };
    const principal = { scope: `public-shop:${id(1)}` };
    const result = await searchCatalog(input, principal);
    assert.equal(result.count, 2);
    assert.equal(result.result_kind, 'related');
    assert.equal(result.degraded, false);
    assert.equal(result.items[0].id, id(8002));
    assert.equal(embeddingCalls, 1);
    assert.deepEqual(thresholds, [.35, .25]);
    assert.ok(cachedWindows.every(window => window.result_kind === 'matched'));
    assert.equal(snapshot.result_kind, 'related');
    const page = await searchCatalog({ ...input, search_id: result.search_id, offset: 1 }, principal);
    assert.equal(page.items[0].id, id(8003));
    assert.equal(page.result_kind, 'related');
    assert.equal(page.search_id, result.search_id);
    assert.equal(embeddingCalls, 1);
    assert.deepEqual(thresholds, [.35, .25]);
  } finally { await db.close(); }
});