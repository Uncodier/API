import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { compile } from '@mdx-js/mdx';
import { load } from 'cheerio';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProductDemo, productDemoUrl, type ProductDemoId } from '../../src/components/ProductDemo';
import demos from '../../src/components/product-demos.json';

test('demo URLs preserve reviewed routes, modes and public sample workspace', () => {
  for (const [id, item] of Object.entries(demos)) {
    const url = new URL(productDemoUrl(id as ProductDemoId));
    assert.equal(url.origin, 'https://demo.makinari.com');
    assert.equal(url.pathname, '/demo');
    assert.equal(url.searchParams.get('client'), 'demo-saas-en-123');
    assert.equal(url.searchParams.get('lang'), 'en');
    assert.equal(url.searchParams.get('theme'), 'light');
    const page = new URL(url.searchParams.get('page')!, url.origin);
    const expected = new URL(item.page, url.origin);
    assert.equal(page.pathname, expected.pathname);
    for (const [key, value] of expected.searchParams) assert.equal(page.searchParams.get(key), value);
    assert.equal(page.searchParams.get('lang'), 'en');
    assert.equal(page.searchParams.get('theme'), 'light');
    assert.equal(page.searchParams.get('mode'), 'mode' in item ? item.mode : null);
  }
});

test('every demo renders an accessible lazy iframe, caption and matching safe fallback', () => {
  for (const id of Object.keys(demos) as ProductDemoId[]) {
    const $ = load(renderToStaticMarkup(<ProductDemo demo={id}>Visual reference for this topic.</ProductDemo>));
    const frame = $('iframe');
    assert.equal(frame.length, 1);
    assert.equal(frame.attr('src'), productDemoUrl(id));
    assert.equal(frame.attr('title'), `${demos[id].title} interactive demo`);
    assert.equal(frame.attr('loading'), 'lazy');
    assert.equal(frame.attr('referrerpolicy'), 'no-referrer');
    assert.ok(frame.attr('sandbox')?.includes('allow-scripts'));
    assert.ok(!frame.attr('sandbox')?.includes('allow-top-navigation'));
    assert.match(frame.attr('style')!, /width:100%/);
    assert.doesNotMatch(frame.attr('style')!, /scale|transform/);
    assert.match($('figcaption').text(), /Visual reference for this topic/);
    assert.match($('figcaption').text(), /not your live Site/);
    assert.equal($('a').attr('href'), frame.attr('src'));
    assert.equal($('a').attr('target'), '_blank');
    assert.equal($('a').attr('rel'), 'noopener noreferrer');
  }
});

test('all public MDX demo references have known IDs, meaningful captions and compile', async () => {
  const root = new URL('../../src/content/', import.meta.url);
  const files = await readdir(root, { recursive: true });
  const used = new Set<string>();
  let pages = 0;
  for (const file of files.filter(file => file.endsWith('.mdx'))) {
    const source = await readFile(new URL(file, root), 'utf8');
    if (!source.includes('<ProductDemo')) continue;
    pages++;
    const references = [...source.matchAll(/<ProductDemo demo="([^"]+)">([^<]+)<\/ProductDemo>/g)];
    assert.equal(references.length, source.split('<ProductDemo').length - 1, file);
    for (const [, id, caption] of references) {
      assert.ok(Object.hasOwn(demos, id), `${file}: unknown demo ${id}`);
      assert.ok(caption.trim().length > 40, `${file}: explain the visual reference`);
      used.add(id);
    }
    await compile(source, { providerImportSource: '../../mdx-components' });
  }
  assert.ok(pages >= 19, 'Keep visual references across guides, concepts, REST and MCP');
  assert.deepEqual([...used].sort(), Object.keys(demos).sort());
  const provider = await readFile(new URL('../../mdx-components.js', import.meta.url), 'utf8');
  assert.match(provider, /import \{ ProductDemo \} from '\.\/src\/components\/ProductDemo'/);
  assert.match(provider, /\.\.\.themeComponents,\s+ProductDemo,/);
});