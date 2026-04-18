---
name: frontend-blog-seo
description: Guide for frontend agents to consume public site content, generate blog pages, and implement high-quality SEO, semantic HTML, and accessible design. Use when the user wants to create a blog, fetch public content for articles, or improve frontend SEO and typography.
types: ['content', 'develop', 'design']
---

# Frontend Blog & SEO Generation

## Quick Start

When asked to create a blog or consume public site content to generate articles:

1. **Fetch Content**: Implement robust fetching of public APIs or RSS feeds.
2. **SEO Optimization**: Add comprehensive metadata, OpenGraph tags, and JSON-LD schema.
3. **Semantic HTML**: Use proper HTML5 tags (`<article>`, `<header>`, `<main>`, `<section>`).
4. **Design & Typography**: Apply consistent typography (e.g., Tailwind Typography plugin) and ensure responsive layout.
5. **Accessibility**: Guarantee high contrast, proper ARIA labels, and keyboard navigability.

## Content Fetching

When consuming public content:

- **Error Handling**: Always include `try/catch` and fallback UI for missing data.
- **Caching & Revalidation**: In modern frameworks (like Next.js), use static generation (SSG) with revalidation (ISR) to keep the blog fast but updated.
- **Types**: Define TypeScript interfaces for the fetched content.

```typescript
// Example Content Interface
export interface BlogPost {
  id: string;
  title: string;
  slug: string;
  excerpt: string;
  content: string;
  publishedAt: string;
  author: {
    name: string;
    avatarUrl?: string;
  };
}
```

## SEO Best Practices

Every blog page must include:

1. **Dynamic Meta Tags**: Title, description, and canonical URL based on the article content.
2. **OpenGraph & Twitter Cards**: For social sharing visibility.
3. **Structured Data (JSON-LD)**: Search engines use this to display rich snippets.

### JSON-LD Template

Always inject a structured data script in the `<head>` of individual blog posts:

```html
<script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    "headline": "Article Title",
    "image": ["https://example.com/image.jpg"],
    "datePublished": "2026-04-15T08:00:00+08:00",
    "dateModified": "2026-04-15T08:00:00+08:00",
    "author": [{
        "@type": "Person",
        "name": "Author Name"
    }]
  }
</script>
```

## Design and Layout

The blog should look professional and focus on readability:

- **Container**: Limit the maximum width of the reading area (e.g., `max-w-prose` or `max-w-3xl`) for optimal line length (65-75 characters).
- **Typography**:
  - Use readable font sizes (e.g., `text-lg` or `text-xl` for body).
  - Ensure distinct hierarchy (`h1`, `h2`, `h3` with appropriate margins and font weights).
  - Use adequate line height (`leading-relaxed` or `leading-loose`).
- **Images**: Make images responsive. Include `alt` text for all images.

### Semantic HTML Example

```html
<article class="max-w-prose mx-auto px-4 py-8">
  <header class="mb-8">
    <h1 class="text-4xl font-bold tracking-tight text-gray-900">Article Title</h1>
    <time datetime="2026-04-15" class="text-gray-500 text-sm">April 15, 2026</time>
  </header>
  
  <div class="prose prose-lg">
    <!-- Content goes here -->
  </div>
</article>
```

## Accessibility (A11y)

- Contrast ratio must be at least 4.5:1 for standard text.
- Use `aria-label` on navigation links.
- Ensure the user can navigate back to the blog index easily.
