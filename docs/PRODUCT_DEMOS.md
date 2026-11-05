# Visual references in public documentation

Public Nextra documentation lives in `src/content`, not in the internal engineering notes in `docs`.
Use the globally registered MDX component next to the relevant explanation:

```mdx
<ProductDemo demo="requirements">Explore the Requirements workspace before creating your own AI goal.</ProductDemo>
```

`src/components/product-demos.json` is the reviewed route catalog. Routes and sample
workspace IDs come from the sibling `commercial-site` repository:

- `app/product/components/product-motion.tsx`: `/demo` URL parameters and sample clients.
- `app/product/crm/CrmClient.tsx`, `CrmBento.tsx`: overview, lead profile, conversations, requirements, robots.
- `app/product/inbound/InboundClient.tsx`: lead list and conversations.
- `app/product/cms/CmsFeatures.tsx`: content and campaigns.
- `app/product/procurement/buying-demos.ts`: requests and tenders.

The docs use `https://demo.makinari.com`, English and a light demo theme, including
in local development. They never embed the authenticated application or pass API
keys, live Site IDs or provider credentials. Demo content is illustrative; it does
not validate an API operation or configure a provider connection.

Frames load lazily, keep readable controls without scaling, and include captions,
accessible titles and an always-visible new-tab fallback. The sandbox permits
scripts, same-origin app behavior, forms and popup flows, but not top navigation.
The demo host must permit the docs origin via CSP `frame-ancestors`; local API
docs on port 3001 are not currently in its local-origin allowlist, so use the
new-tab link there. An iframe load event alone cannot verify cross-origin content.

Run the offline render and MDX compilation checks with:

```bash
node --import tsx --test __tests__/build/product-demos.test.tsx
```

When adding a view, confirm its route in `commercial-site`, add a catalog entry,
and explain exactly which part of the topic it illustrates. Do not add unrelated
demos to authentication, webhook signatures or backend-only workflow contracts.