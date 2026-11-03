import { mkdtemp, writeFile, rm, access, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { initialFiles } from './cases.mjs';

const names = Object.keys(initialFiles);
const products = [
  { id: 'mug', name: 'Cedar Mug', category: 'home', price: 18 },
  { id: 'tote', name: 'Trail Tote', category: 'outdoors', price: 32 },
  { id: 'throw', name: 'Linen Throw', category: 'home', price: 64 },
];
const copy = ['Cedar Supply', 'Everyday goods, thoughtfully made.', 'Small comforts. Lasting quality.',
  'Shop essentials', 'Contact', 'Explore the collection', 'The everyday collection', 'Made for the everyday.', 'Shipping & returns'];
const links = ['#home', '#catalog', 'mailto:hello@cedar.example', '#catalog', 'https://cedar.example/shipping'];

// Agent sources execute only in a bounded subprocess, never imported into this host.
// Node's permission model restricts filesystem, network, processes, and native addons.
async function inspectModules(dir) {
  // Earlier permission models do not reliably restrict network access.
  if (Number(process.versions.node.split('.')[0]) < 25) return null;
  const script = `import { writeSync } from 'node:fs';
const send = value => writeSync(3, JSON.stringify(value));
const app = await import(${JSON.stringify(pathToFileURL(join(dir, 'app.mjs')).href)});
const { catalog } = await import(${JSON.stringify(pathToFileURL(join(dir, 'catalog.mjs')).href)});
const lines = [{price:18,quantity:2},{price:32,quantity:3}];
const decimals = [{price:0.1,quantity:3},{price:1.25,quantity:4},{price:99,quantity:0}];
const sample = [{id:'a',category:'home'},{id:'b',category:'outdoors'},{id:'c',category:'home'},{id:'d',category:'other'}];
const before = JSON.stringify([lines,decimals,sample,catalog]);
for (const values of [lines, decimals, sample]) { values.forEach(Object.freeze); Object.freeze(values); }
const result = { exports: ['subtotal','filterCatalog','formatMoney','renderCatalog'].every(k => typeof app[k] === 'function'), catalog,
money: [app.formatMoney(0),app.formatMoney(18),app.formatMoney(1.25)],
totals: [app.subtotal([]),app.subtotal(lines),app.subtotal(decimals),app.subtotal([{price:7,quantity:0}]),app.subtotal([{price:2.5,quantity:7}])],
filters: ['all','home','outdoors','unknown'].map(c => app.filterCatalog(sample,c).map(x=>x.id)) };
result.immutable = before === JSON.stringify([lines,decimals,sample,catalog]); send(result);`;
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--permission', `--allow-fs-read=${dir}`, '--input-type=module', '--eval', script], {
      cwd: dir, env: { PATH: '' }, stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
    });
    let output = ''; let overflow = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.stdio[3].on('data', chunk => {
      output += chunk;
      if (output.length > 32768) { overflow = true; child.kill('SIGKILL'); }
    });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', code => {
      clearTimeout(timer);
      try { resolve(code === 0 && !overflow ? JSON.parse(output) : null); } catch { resolve(null); }
    });
  });
}

async function launchBrowser() {
  const { default: puppeteer } = await import('puppeteer');
  const candidates = [process.env.HARNESS_CHROME_EXECUTABLE, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    puppeteer.executablePath(), '/usr/bin/chromium', '/usr/bin/google-chrome'].filter(Boolean);
  for (const executablePath of candidates) {
    try {
      await access(executablePath);
      return await puppeteer.launch({ executablePath, headless: true, timeout: 10000, env: { HOME: tmpdir(), PATH: '/usr/bin:/bin' },
        args: ['--disable-background-networking', '--disable-component-update', '--no-first-run', '--disable-sync'] });
    } catch { /* unavailable browsers fail closed below */ }
  }
  throw new Error('Browser unavailable');
}

async function inspectBrowser(caseId, files) {
  const browser = await launchBrowser();
  const watchdog = setTimeout(() => browser.process()?.kill('SIGKILL'), 20000);
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    await page.setViewport({ width: 1200, height: 900 });
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (url.origin !== 'https://cedar-fixture.invalid' || !names.includes(name)) { void request.abort(); return; }
      const contentType = name.endsWith('.html') ? 'text/html' : name.endsWith('.css') ? 'text/css' : 'text/javascript';
      void request.respond({ status: 200, contentType, body: files[name], headers: {
        'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'none'; img-src 'none'; font-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
      } });
    });
    const errors = [];
    page.on('pageerror', () => errors.push(true));
    await page.goto('https://cedar-fixture.invalid/', { waitUntil: 'networkidle0', timeout: 10000 });
    const base = await page.evaluate(() => {
      const visible = element => !!element && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0 && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none';
      return {
        text: document.body.innerText,
        links: [...document.querySelectorAll('a')].map(a => a.getAttribute('href')),
        cards: [...document.querySelectorAll('.product')].map(card => ({ id: card.dataset.id, name: card.querySelector('h3')?.innerText, price: card.querySelector('.price')?.innerText, visible: visible(card) })),
        controls: document.querySelectorAll('[data-quantity]').length === 3 && [...document.querySelectorAll('[data-quantity]')].every(e => visible(e) && !e.disabled),
      };
    });
    const result = {
      'browser-runtime': errors.length === 0,
      'preserved-copy-links': copy.every(value => base.text.includes(value)) && JSON.stringify(base.links) === JSON.stringify(links),
      'preserved-visible-products': JSON.stringify(base.cards) === JSON.stringify(products.map(p => ({ id: p.id, name: p.name, price: `$${p.price.toFixed(2)}`, visible: true }))) && base.controls,
    };
    async function quantity(id, amount) {
      await page.$eval(`[data-quantity="${id}"]`, (input, value) => { input.value = String(value); input.dispatchEvent(new Event('input', { bubbles: true })); }, amount);
    }
    const subtotalText = () => page.$eval('#subtotal', e => e.innerText);
    if (caseId === 'quantity-subtotal') {
      result['cart-empty'] = await subtotalText() === 'Subtotal: $0.00';
      await quantity('mug', 2); await quantity('tote', 3);
      result['cart-multiple-quantities'] = await subtotalText() === 'Subtotal: $132.00';
      await quantity('mug', 0);
      result['cart-zero-quantity'] = await subtotalText() === 'Subtotal: $96.00';
      await quantity('tote', 0);
      result['cart-cleared'] = await subtotalText() === 'Subtotal: $0.00';
    }
    if (caseId === 'category-filter') {
      result['filter-enabled-labeled'] = await page.$eval('#category', e => !e.disabled && !!document.querySelector('label[for="category"]'));
      await quantity('mug', 2);
      const state = () => page.evaluate(() => ({ ids: [...document.querySelectorAll('.product')].filter(e => e.getBoundingClientRect().height > 0).map(e => e.dataset.id), count: document.querySelector('#result-count').innerText }));
      for (const [category, ids] of [['home', ['mug', 'throw']], ['outdoors', ['tote']], ['all', ['mug', 'tote', 'throw']]]) {
        await page.select('#category', category);
        const actual = await state();
        result[`filter-ui-${category}`] = JSON.stringify(actual.ids) === JSON.stringify(ids) && actual.count === `${ids.length} products`;
      }
      result['filter-preserves-quantity'] = await page.$eval('[data-quantity="mug"]', e => e.value === '2');
    }
    if (caseId === 'landing-polish') {
      const geometry = () => page.evaluate(() => {
        const hero = document.querySelector('.hero'); const heading = document.querySelector('h1');
        const cards = [...document.querySelectorAll('.product')];
        const h = getComputedStyle(hero); const c = cards.map(e => getComputedStyle(e));
        return { background: h.backgroundColor, padding: parseFloat(h.paddingTop), heading: parseFloat(getComputedStyle(heading).fontSize),
          cards: cards.map(e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width }; }),
          padded: c.every(s => parseFloat(s.paddingTop) >= 16 && parseFloat(s.paddingLeft) >= 16 && parseFloat(s.borderTopLeftRadius) >= 12),
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      const desktop = await geometry();
      result['visual-hero'] = !['rgb(255, 255, 255)', 'rgba(0, 0, 0, 0)'].includes(desktop.background) && desktop.padding >= 32 && desktop.heading >= 40;
      result['visual-desktop-grid'] = desktop.cards.length === 3 && desktop.cards.every(c => Math.abs(c.y - desktop.cards[0].y) < 2 && Math.abs(c.width - desktop.cards[0].width) < 2) && desktop.cards[1].x > desktop.cards[0].x + desktop.cards[0].width - 2;
      result['visual-card-polish'] = desktop.padded;
      await page.setViewport({ width: 390, height: 844 });
      const mobile = await geometry();
      result['visual-mobile-stack'] = mobile.cards.length === 3 && mobile.cards[1].y > mobile.cards[0].y && mobile.cards.every(c => Math.abs(c.x - mobile.cards[0].x) < 2) && !mobile.overflow && mobile.heading >= 32;
    }
    result['browser-runtime'] = errors.length === 0;
    return result;
  } finally { clearTimeout(watchdog); await browser.close(); }
}

export async function verifyFiles(caseId, files) {
  const checks = [];
  const check = (id, passed) => checks.push({ id, passed: passed === true });
  const valid = ['landing-polish', 'quantity-subtotal', 'category-filter'].includes(caseId);
  check('known-case', valid);
  const complete = files && typeof files === 'object' && names.every(name => typeof files[name] === 'string' && files[name].length <= 200000) && Object.keys(files).length === names.length;
  check('existing-files-only', Boolean(complete));
  if (valid && complete) {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'cedar-oracle-')));
    try {
      await Promise.all(names.map(name => writeFile(join(dir, name), files[name])));
      const modules = await inspectModules(dir);
      check('isolated-module-execution', !!modules);
      check('preserved-exports', modules?.exports);
      check('preserved-catalog', JSON.stringify(modules?.catalog) === JSON.stringify(products));
      check('preserved-money-format', JSON.stringify(modules?.money) === JSON.stringify(['$0.00', '$18.00', '$1.25']));
      check('immutable-inputs', modules?.immutable);
      if (caseId === 'quantity-subtotal') check('subtotal-functional-vectors', Array.isArray(modules?.totals) && modules.totals.every((n, i) => typeof n === 'number' && Math.abs(n - [0, 132, 5.3, 0, 17.5][i]) < 1e-9) && modules.totals.length === 5);
      if (caseId === 'category-filter') check('filter-functional-vectors', JSON.stringify(modules?.filters) === JSON.stringify([['a', 'b', 'c', 'd'], ['a', 'c'], ['b'], []]));
      try {
        const browser = await inspectBrowser(caseId, files);
        for (const [id, passed] of Object.entries(browser)) check(id, passed);
      } catch { check('browser-verification', false); }
    } catch { check('oracle-execution', false); }
    finally { await rm(dir, { recursive: true, force: true }); }
  }
  const passed = checks.filter(c => c.passed).length;
  return { passed: passed === checks.length, checks, counts: { total: checks.length, passed, failed: checks.length - passed } };
}