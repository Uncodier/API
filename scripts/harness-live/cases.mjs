// Synthetic, dependency-free existing app. Verifiers live outside fixtureRoot.
export const initialFiles = Object.freeze({
  'index.html': `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Cedar Supply</title><link rel="stylesheet" href="./styles.css"></head>
<body><header><a href="#home">Cedar Supply</a><nav><a href="#catalog">Shop essentials</a><a href="mailto:hello@cedar.example">Contact</a></nav></header>
<main id="home"><section class="hero"><p>Everyday goods, thoughtfully made.</p><h1>Small comforts. Lasting quality.</h1><a class="cta" href="#catalog">Explore the collection</a></section>
<section id="catalog"><h2>The everyday collection</h2><label for="category">Category</label><select id="category" disabled><option value="all">All</option><option value="home">Home</option><option value="outdoors">Outdoors</option></select><p id="result-count" aria-live="polite"></p><div id="products" class="products"></div></section>
<aside aria-label="Shopping cart"><h2>Your bag</h2><p id="subtotal" aria-live="polite">Subtotal: $0.00</p></aside></main>
<footer>Made for the everyday.<a href="https://cedar.example/shipping">Shipping &amp; returns</a></footer><script type="module" src="./app.mjs"></script></body></html>
`,
  'catalog.mjs': `export const catalog = [
  { id: 'mug', name: 'Cedar Mug', category: 'home', price: 18 },
  { id: 'tote', name: 'Trail Tote', category: 'outdoors', price: 32 },
  { id: 'throw', name: 'Linen Throw', category: 'home', price: 64 }
];
`,
  'styles.css': `body { margin: 8px; font-family: Arial, sans-serif; color: #192b24; background: white; }
header, nav, footer { display: flex; gap: 16px; }
.hero { padding: 8px; }
h1 { font-size: 24px; }
.products { display: block; }
.product { border: 1px solid #999; margin: 4px 0; padding: 4px; }
button, select, input { font: inherit; }
`,
  'app.mjs': `import { catalog } from './catalog.mjs';
export function formatMoney(value) { return '$' + value.toFixed(2); }
export function subtotal(items) { return items.reduce((sum, item) => sum + item.price, 0); }
export function filterCatalog(items, category) { return items.slice(); }
export function renderCatalog(items) {
  const products = document.querySelector('#products');
  products.replaceChildren();
  for (const item of items) {
    const card = document.createElement('article');
    card.className = 'product'; card.dataset.id = item.id;
    const title = document.createElement('h3'); title.textContent = item.name;
    const price = document.createElement('p'); price.className = 'price'; price.textContent = formatMoney(item.price);
    const label = document.createElement('label'); label.textContent = 'Quantity for ' + item.name;
    const input = document.createElement('input'); input.type = 'number'; input.min = '0'; input.max = '99'; input.value = String(quantities[item.id] || 0); input.dataset.quantity = item.id;
    label.append(input); input.addEventListener('input', () => { quantities[item.id] = Number(input.value); updateSubtotal(); });
    card.append(title, price, label); products.append(card);
  }
  document.querySelector('#result-count').textContent = items.length + ' products';
}
const quantities = {};
function updateSubtotal() {
  const lines = catalog.filter(item => quantities[item.id] > 0).map(item => ({ ...item, quantity: quantities[item.id] }));
  document.querySelector('#subtotal').textContent = 'Subtotal: ' + formatMoney(subtotal(lines));
}
if (typeof document !== 'undefined') {
  renderCatalog(catalog);
  document.querySelector('#category').addEventListener('change', event => renderCatalog(filterCatalog(catalog, event.target.value)));
}
`,
});

export function cases(runId) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(runId)) throw new Error('Invalid run ID');
  const fixtureRoot = `.harness-live/${runId}`;
  const shared = `Modify the existing vanilla HTML/ESM Cedar app in ${fixtureRoot}. No installs, external assets, new replacement files, test files, or changes outside the four existing files. Keep the original exports formatMoney, subtotal(items), filterCatalog(items, category), renderCatalog and working quantity UI. Preserve exact brand copy, product names, prices, and all link destinations. `;
  const definitions = [
    ['landing-polish', 'Polish the landing page visibly using CSS: warm non-white hero background, hero padding at least 32px, desktop heading at least 40px, three equal product columns at 1200px and one at 390px, cards with padding at least 16px and radius at least 12px. At 390px use heading at least 32px and prevent horizontal overflow. Retain all content and usable controls.'],
    ['quantity-subtotal', 'Fix subtotal so each price is multiplied by its quantity (including zero and fractional prices); empty cart totals zero and inputs are not mutated. Wire the actual quantity controls: 2 Cedar Mugs plus 3 Trail Totes totals $132.00; changing mugs to 0 totals $96.00.'],
    ['category-filter', 'Enable the existing labeled Category select and implement filterCatalog: all returns all products in order, home returns only home products, outdoors only outdoors, unknown returns empty; never mutate inputs. Selection must update the visible cards and live result count, preserve quantities across filtering, and All must restore all products.'],
  ];
  return definitions.map(([id, request]) => ({ id, type: 'develop', fixtureRoot,
    allowedPaths: Object.keys(initialFiles).map(name => `${fixtureRoot}/${name}`), request: shared + request }));
}