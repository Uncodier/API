import demos from './product-demos.json';

export type ProductDemoId = keyof typeof demos;

// Matches commercial-site/app/product/components/product-motion.tsx.
// Always use the public demo, including in local docs: no account is required.
export function productDemoUrl(demo: ProductDemoId) {
  const item = demos[demo];
  const page = new URL(item.page, 'https://demo.makinari.com');
  if ('mode' in item) page.searchParams.set('mode', item.mode);
  page.searchParams.set('lang', 'en');
  page.searchParams.set('theme', 'light');

  const url = new URL('/demo', page.origin);
  url.searchParams.set('client', 'demo-saas-en-123');
  url.searchParams.set('lang', 'en');
  url.searchParams.set('theme', 'light');
  url.searchParams.set('page', `${page.pathname}${page.search}`);
  return url.href;
}

/** A readable visual reference, not an authenticated API playground. */
export function ProductDemo({ demo, children }: {
  demo: ProductDemoId;
  children: string;
}) {
  const title = demos[demo].title;
  const src = productDemoUrl(demo);

  return (
    <figure data-product-demo={demo} style={{ margin: '1.5rem 0', width: '100%' }}>
      <figcaption style={{ marginBottom: '0.75rem', lineHeight: 1.6 }}>
        <strong>{title} — interactive demo</strong>
        <div>{children}</div>
        <small>Sample workspace, not your live Site. This visual reference does not verify API calls or configure your integrations.</small>
      </figcaption>
      <iframe
        src={src}
        title={`${title} interactive demo`}
        loading="lazy"
        referrerPolicy="no-referrer"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
        style={{ width: '100%', height: 'clamp(420px, 70vh, 720px)', display: 'block', border: '1px solid #94a3b8', borderRadius: '0.75rem', background: '#fff' }}
      />
      <div style={{ marginTop: '0.5rem' }}>
        <a href={src} target="_blank" rel="noopener noreferrer">Open {title.toLowerCase()} demo in a new tab ↗</a>
        <small style={{ display: 'block' }}>Scroll inside the demo to explore. If it does not load or you need more space, use the link above.</small>
      </div>
    </figure>
  );
}