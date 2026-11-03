import test from 'node:test';
import assert from 'node:assert/strict';
import { initialFiles, cases } from '../../scripts/harness-live/cases.mjs';
import { verifyFiles } from '../../scripts/harness-live/oracle.mjs';

const fixedCart = () => ({ ...initialFiles, 'app.mjs': initialFiles['app.mjs'].replace(
  'sum + item.price, 0)', 'sum + item.price * item.quantity, 0)') });
const fixedFilter = () => ({ ...initialFiles,
  'index.html': initialFiles['index.html'].replace('id="category" disabled', 'id="category"'),
  'app.mjs': initialFiles['app.mjs'].replace('return items.slice();',
    "return category === 'all' ? items.slice() : items.filter(item => item.category === category);"),
});
const polished = () => ({ ...initialFiles, 'styles.css': initialFiles['styles.css'] + `
* { box-sizing: border-box; }
body { margin: 0; }
header, footer { flex-wrap: wrap; padding: 24px; }
main { padding: 24px; }
.hero { padding: 40px; background: #eee4d3; }
h1 { font-size: 48px; }
.products { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 20px; }
.product { padding: 20px; border-radius: 16px; }
input { max-width: 100%; }
@media (max-width: 600px) {
  .products { grid-template-columns: 1fr; }
  h1 { font-size: 36px; }
  .hero { padding: 32px; }
}
` });

function check(result, id) {
  const value = result.checks.find(c => c.id === id);
  assert.ok(value, `missing fixed check ${id}`);
  return value.passed;
}
function safe(result) {
  assert.deepEqual(Object.keys(result), ['passed', 'checks', 'counts']);
  assert.equal(result.counts.total, result.checks.length);
  assert.equal(result.counts.failed, result.checks.filter(c => !c.passed).length);
  for (const c of result.checks) {
    assert.deepEqual(Object.keys(c), ['id', 'passed']);
    assert.match(c.id, /^[a-z-]+$/);
    assert.equal(typeof c.passed, 'boolean');
  }
}

test('cases use existing source files in unique run-only tree', () => {
  const suite = cases('offline_run_42');
  assert.equal(suite.length, 3);
  assert.equal(new Set(suite.map(c => c.id)).size, 3);
  assert.deepEqual(Object.keys(initialFiles).sort(), ['app.mjs', 'catalog.mjs', 'index.html', 'styles.css']);
  for (const c of suite) {
    assert.equal(c.type, 'develop');
    assert.equal(c.fixtureRoot, '.harness-live/offline_run_42');
    assert.equal(c.allowedPaths.length, 4);
    assert.ok(c.allowedPaths.every(p => p.startsWith(`${c.fixtureRoot}/`)));
    assert.match(c.request, /existing/);
    assert.ok(!c.allowedPaths.some(p => p.includes('test') || p.includes('oracle')));
  }
  for (const invalid of ['../escape', '', 'a/b', 'a'.repeat(81)]) assert.throws(() => cases(invalid));
});

test('actual Chromium and isolated modules reject no-op baseline for every target', async () => {
  for (const { id } of cases('baseline')) {
    const result = await verifyFiles(id, initialFiles);
    safe(result);
    assert.equal(result.passed, false);
    assert.equal(check(result, 'isolated-module-execution'), true);
    assert.equal(check(result, 'browser-runtime'), true);
    assert.equal(check(result, 'preserved-catalog'), true);
    assert.equal(check(result, 'preserved-copy-links'), true);
    const target = { 'landing-polish': 'visual-hero', 'quantity-subtotal': 'subtotal-functional-vectors', 'category-filter': 'filter-functional-vectors' }[id];
    assert.equal(check(result, target), false);
  }
});

test('independently repaired sources pass target plus preservation checks', async () => {
  for (const [id, files] of [['landing-polish', polished()], ['quantity-subtotal', fixedCart()], ['category-filter', fixedFilter()]]) {
    const result = await verifyFiles(id, files);
    safe(result);
    assert.equal(result.passed, true, JSON.stringify(result));
  }
});

test('wrong, hardcoded and mutating totals fail despite plausible UI code', async () => {
  for (const body of [
    'return 132;',
    'return items.reduce((s, x) => s + x.price * (x.quantity || 1), 0);',
    'items.reverse(); return items.reduce((s, x) => s + x.price * x.quantity, 0);',
  ]) {
    const files = fixedCart();
    files['app.mjs'] = files['app.mjs'].replace(/export function subtotal\(items\) \{[^}]*\}/, `export function subtotal(items) { ${body} }`);
    const result = await verifyFiles('quantity-subtotal', files);
    assert.equal(result.passed, false);
    assert.ok(!check(result, 'subtotal-functional-vectors') || !check(result, 'immutable-inputs'));
  }
});

test('functional fix cannot change catalog prices or original links/copy', async () => {
  const changedPrice = fixedCart();
  changedPrice['catalog.mjs'] = changedPrice['catalog.mjs'].replace('price: 18', 'price: 1');
  const priceResult = await verifyFiles('quantity-subtotal', changedPrice);
  assert.equal(check(priceResult, 'preserved-catalog'), false);
  assert.equal(priceResult.passed, false);
  const changedLink = fixedCart();
  changedLink['index.html'] = changedLink['index.html'].replace('https://cedar.example/shipping', 'https://other.invalid/');
  const linkResult = await verifyFiles('quantity-subtotal', changedLink);
  assert.equal(check(linkResult, 'preserved-copy-links'), false);
  const changedCopy = polished();
  changedCopy['index.html'] = changedCopy['index.html'].replace('Small comforts. Lasting quality.', 'New copy');
  assert.equal(check(await verifyFiles('landing-polish', changedCopy), 'preserved-copy-links'), false);
});

test('filter export without live select wiring and erased original functions fail', async () => {
  const disabled = fixedFilter();
  disabled['index.html'] = initialFiles['index.html'];
  const result = await verifyFiles('category-filter', disabled);
  assert.equal(check(result, 'filter-functional-vectors'), true);
  assert.equal(check(result, 'filter-enabled-labeled'), false);
  assert.equal(result.passed, false);
  const erased = fixedCart();
  erased['app.mjs'] = erased['app.mjs'].replace('export function renderCatalog', 'function renderCatalog');
  assert.equal(check(await verifyFiles('quantity-subtotal', erased), 'preserved-exports'), false);
});

test('forged test success and claimed result metadata never replace external verification', async () => {
  const files = { ...initialFiles, 'app.mjs': initialFiles['app.mjs'] + '\nconsole.log("ALL TESTS PASSED: 999");\n// {"passed":true,"checks":[]}\n' };
  const result = await verifyFiles('quantity-subtotal', files);
  assert.equal(result.passed, false);
  assert.equal(check(result, 'subtotal-functional-vectors'), false);
  assert.ok(!JSON.stringify(result).includes('999'));
  for (const extra of ['oracle.mjs', 'tests.mjs', 'passed']) {
    const injected = await verifyFiles('quantity-subtotal', { ...fixedCart(), [extra]: 'true' });
    assert.equal(check(injected, 'existing-files-only'), false);
    assert.equal(injected.passed, false);
  }
});

test('CSS tokens hidden in comments do not substitute for rendered visual changes', async () => {
  const files = { ...initialFiles, 'styles.css': initialFiles['styles.css'] + '/* .hero { padding: 40px; background: #eee4d3; } h1 { font-size: 48px; } .products { display: grid; grid-template-columns: repeat(3, 1fr); } .product { padding: 20px; border-radius: 16px; } */' };
  const result = await verifyFiles('landing-polish', files);
  assert.equal(check(result, 'browser-runtime'), true);
  assert.equal(check(result, 'visual-hero'), false);
  assert.equal(check(result, 'visual-desktop-grid'), false);
  assert.equal(check(result, 'visual-card-polish'), false);
  assert.equal(result.passed, false);
});

test('permission-restricted import cannot read host source, spawn or use network', async () => {
  for (const attack of [
    "import { readFileSync } from 'node:fs'; readFileSync('/etc/hosts');",
    "import { spawnSync } from 'node:child_process'; spawnSync('echo', ['forged']);",
    "import { connect } from 'node:net'; connect(443, 'example.invalid');",
  ]) {
    const result = await verifyFiles('quantity-subtotal', { ...fixedCart(), 'app.mjs': attack + '\n' + fixedCart()['app.mjs'] });
    assert.equal(check(result, 'isolated-module-execution'), false);
    assert.equal(result.passed, false);
    safe(result);
    assert.ok(!JSON.stringify(result).includes('/etc/hosts'));
  }
});

test('unknown, incomplete and oversized fixtures fail closed with safe fixed output', async () => {
  for (const [id, files] of [['unknown', initialFiles], ['quantity-subtotal', {}], ['landing-polish', { ...initialFiles, 'styles.css': 'x'.repeat(200001) }]]) {
    const result = await verifyFiles(id, files);
    safe(result);
    assert.equal(result.passed, false);
  }
});