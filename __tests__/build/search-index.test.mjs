import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { buildSearchIndex } from '../../scripts/build-search-index.mjs';

const require = createRequire(import.meta.url);
// Exercise the installed Next version's actual adapter path format. A future
// incompatible format must fail this regression, not silently break deployment.
const { getRouteCacheKey } = require('next/dist/server/lib/route-cache-key');
const sourceRoute = '/[[...mdxPath]]/page';
const docRoutes = {
  '/': { srcRoute: '/[[...mdxPath]]', dataRoute: '/index.rsc' },
  '/guides/setup': { srcRoute: '/[[...mdxPath]]', dataRoute: '/guides/setup.rsc' },
};
const html = (title) => `<html lang="en"><head><title>${title}</title></head><body>
  <nav>NavigationOnly</nav><main data-pagefind-body><h1>${title}</h1>
  <h2 id="installation">Installation</h2><p>Searchable documentation instructions.</p></main></body></html>`;

async function write(root, relative, content) {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function fixture(t, { scoped = false, routes = docRoutes } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'search-index-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await write(root, '.next/prerender-manifest.json', JSON.stringify({ routes }));
  for (const [url, entry] of Object.entries(routes)) {
    const file = scoped
      ? `.next/server${getRouteCacheKey(url, { kind: 'APP_PAGE', sourceRoute })}.html`
      : `.next/server/app${entry.dataRoute.replace(/\.rsc$/, '.html')}`;
    await write(root, file, html(url === '/' ? 'Home' : 'Setup'));
  }
  return root;
}

async function fragments(bundle) {
  const files = await readdir(path.join(bundle, 'fragment'));
  return Promise.all(files.map(async (file) => {
    const compressed = await readFile(path.join(bundle, 'fragment', file));
    return JSON.parse(gunzipSync(compressed).toString().replace(/^pagefind_dcd/, ''));
  }));
}

async function assertBundle(bundle) {
  const entry = JSON.parse(await readFile(path.join(bundle, 'pagefind-entry.json'), 'utf8'));
  assert.equal(entry.languages.en.page_count, 2);
  assert.ok((await readFile(path.join(bundle, 'pagefind.js'))).length);
  const records = await fragments(bundle);
  assert.deepEqual(records.map((record) => record.url).sort(), ['/', '/guides/setup']);
  for (const record of records) {
    assert.match(record.content, /Searchable documentation instructions/);
    assert.doesNotMatch(record.content, /NavigationOnly|UnrelatedContent|StaleContent/);
    assert.doesNotMatch(record.url, /route-cache|APP_PAGE|\$|\.html/);
    assert.ok(record.anchors.some((anchor) => anchor.id === 'installation'));
  }
}

test('indexes traditional Next HTML with public URLs and excludes non-documentation pages', async (t) => {
  const root = await fixture(t);
  await write(root, '.next/server/app/_not-found.html', html('UnrelatedContent'));
  await write(root, '.next/server/app/api/private.html', html('UnrelatedContent'));
  await write(root, 'public/_pagefind/stale.txt', 'StaleContent');
  const result = await buildSearchIndex(root);
  assert.equal(result.pages, 2);
  assert.equal(result.source, path.join(root, '.next/server/app'));
  assert.deepEqual(result.outputs, [path.join(root, 'public/_pagefind')]);
  await assertBundle(result.outputs[0]);
  await assert.rejects(readFile(path.join(result.outputs[0], 'stale.txt')), { code: 'ENOENT' });
});

test('indexes the installed Next adapter layout and refreshes the packaged search bundle', async (t) => {
  const root = await fixture(t, { scoped: true });
  await write(root, '.next/output/config.json', JSON.stringify({ version: 3 }));
  await write(root, '.next/output/static/_pagefind/stale.txt', 'StaleContent');
  await write(root, '.next/output/static/_pagefind/pagefind-entry.json', '{}');
  await write(root, '.next/output/static/keep.txt', 'Unrelated static asset');
  // A cached legacy output must not win over the current adapter artifacts.
  await write(root, '.next/server/app/index.html', html('StaleContent'));
  const result = await buildSearchIndex(root);
  assert.equal(result.pages, 2);
  assert.equal(result.source, path.join(root, '.next/server/route-cache/APP_PAGE'));
  assert.equal(result.outputs.length, 2);
  for (const output of result.outputs) await assertBundle(output);
  const files = await readdir(result.outputs[0], { recursive: true, withFileTypes: true });
  for (const entry of files.filter((entry) => entry.isFile())) {
    const relative = path.relative(result.outputs[0], path.join(entry.parentPath, entry.name));
    assert.deepEqual(
      await readFile(path.join(result.outputs[0], relative)),
      await readFile(path.join(result.outputs[1], relative)),
    );
  }
  await assert.rejects(readFile(path.join(result.outputs[1], 'stale.txt')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(root, '.next/output/static/keep.txt'), 'utf8'), 'Unrelated static asset');
});

for (const emptyDirectory of [false, true]) {
  test(`fails clearly with ${emptyDirectory ? 'empty' : 'missing'} HTML output instead of masking a broken build`, async (t) => {
    const root = await fixture(t);
    await rm(path.join(root, '.next/server/app'), { recursive: true });
    if (emptyDirectory) await mkdir(path.join(root, '.next/server/app'));
    await assert.rejects(buildSearchIndex(root), /missing prerendered HTML for \/ .*Run a full next build/);
  });
}

test('rejects partial adapter output instead of indexing stale legacy HTML', async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, '.next/server/route-cache/APP_PAGE'), { recursive: true });
  await assert.rejects(buildSearchIndex(root), /missing prerendered HTML.*route-cache/);
});

test('rejects incomplete documentation and leaves the previous bundle untouched', async (t) => {
  const root = await fixture(t);
  await rm(path.join(root, '.next/server/app/guides/setup.html'));
  await write(root, 'public/_pagefind/keep.txt', 'Previous bundle');
  await assert.rejects(buildSearchIndex(root), /missing prerendered HTML for \/guides\/setup/);
  assert.equal(await readFile(path.join(root, 'public/_pagefind/keep.txt'), 'utf8'), 'Previous bundle');
});

test('rejects pages without Nextra searchable content instead of indexing navigation only', async (t) => {
  const root = await fixture(t);
  await write(root, '.next/server/app/index.html', '<html><body>Navigation only</body></html>');
  await assert.rejects(buildSearchIndex(root), /has no data-pagefind-body/);
});

test('rejects a manifest without prerendered documentation', async (t) => {
  const root = await fixture(t, { routes: {} });
  await assert.rejects(buildSearchIndex(root), /no prerendered documentation routes/);
});

test('rejects ambiguous adapter HTML rather than publishing duplicate or incorrect URLs', async (t) => {
  const root = await fixture(t, { scoped: true });
  const key = getRouteCacheKey('/', { kind: 'APP_PAGE', sourceRoute: '/other/page' });
  await write(root, `.next/server${key}.html`, html('UnrelatedContent'));
  await assert.rejects(buildSearchIndex(root), /ambiguous prerendered HTML for index.html/);
});