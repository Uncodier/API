---
name: marketing-seo-gtm
description: Implements Google Tag Manager, technical SEO, Schema.org JSON-LD, and Generative Engine Optimization (GEO).
types: ['optimization', 'marketing_campaign', 'integration']
---

# SKILL: marketing-seo-gtm

## Objective
Implement Technical Marketing, SEO, and Web Analytics. Configure tracking, structure content for search engines, and implement Google Tag Manager following best practices.

## Instructions
1. **Google Tag Manager (GTM):** Implement the GTM snippet correctly in the `<head>` and `<body>` (noscript). Use `dataLayer.push()` to send custom events and variables. **Never** overwrite the entire `dataLayer` (e.g., `window.dataLayer = [...]`). Structure `dataLayer` events semantically (e.g., `event: 'ecommerce_purchase'`, `ecommerce: { items: [...] }`). Ensure events fire at the right time (e.g., after component mount).
2. **Technical SEO & Metadata:** Implement dynamic and accurate meta tags (Title, Description, Canonical URL). Configure OpenGraph (`og:title`, `og:image`) and Twitter Cards for social sharing. Use semantic, user-friendly URLs. Ensure a proper heading hierarchy (`<h1>`, `<h2>`, etc.) to structure content.
3. **Schema.org & JSON-LD:** Implement structured data using JSON-LD (`<script type="application/ld+json">`). Use appropriate schemas for the content (e.g., `Article`, `Product`, `Organization`, `FAQPage`, `BreadcrumbList`). Validate that the JSON-LD is correctly formatted and nested.
4. **Generative Engine Optimization (GEO):** Structure content to be easily digestible by AI (ChatGPT, Perplexity, Gemini). Use clear language, lists, tables, and concise summaries. Include citations and references to authoritative sources. Answer common questions (FAQs) directly and structurally. If using MCP tools like **Superlines**, analyze brand visibility and optimize content based on real AI search data.

## Tools
| Tool | When to use |
| --- | --- |
| `sandbox_write_file` | Update `<head>`, layout files, or SEO components with tracking and metadata. |

## Artifacts
- **Produces**: SEO-optimized HTML, JSON-LD schemas, and GTM dataLayer implementations.
- **Consumes**: `requirement.instructions` (marketing and tracking requirements).
