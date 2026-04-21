---
name: saas-landing-page-generator
description: Generate modern SaaS product landing pages with multiple design styles, outputting deployable HTML/CSS/React code. Use when the requirement is a SaaS marketing site (dashboard tools, AI products, B2B platforms, mobile apps, developer tooling).
types: ['develop', 'content', 'design', 'marketing_campaign']
---

# SaaS Landing Page Generator

Generate professional SaaS product landing pages with ready-to-deploy code via the `saas-landing-page` script.

## Features

- Multiple design styles selectable by template.
- Fully responsive layouts.
- Performance-minded output (minimal JS, optimized assets).
- Componentized code.
- SEO-friendly defaults.
- Directly deployable output.

## Template Styles

| Template | Best for |
| --- | --- |
| `modern` | SaaS dashboards, AI tools |
| `minimal` | Simple tools, browser extensions |
| `b2b` | Enterprise services, API products |
| `mobile-app` | iOS / Android apps |
| `developer` | Developer tools, SDKs |

## Usage

### Generate a landing page

```bash
# Basic
saas-landing-page "<Product name>" "<One-line description>"

# With a specific template
saas-landing-page "AI Writer" "AI-powered writing assistant" --template modern

# With a specific tech stack
saas-landing-page "<Product>" "<Description>" --stack react --style tailwind
```

### Options

| Option | Meaning |
| --- | --- |
| `--template, -t` | Template style (from the table above). |
| `--stack, -s` | Tech stack: `html`, `react`, `vue`, `nextjs`. |
| `--style, -st` | Styling system: `tailwind`, `bootstrap`, `plain`. |
| `--output, -o` | Output directory. |
| `--color, -c` | Primary brand color. |

## Output Structure

```
my-saas-landing/
├── index.html           # or App.js (React)
├── styles.css           # or Tailwind config
├── components/
│   ├── Hero.jsx
│   ├── Features.jsx
│   ├── Pricing.jsx
│   ├── Testimonials.jsx
│   ├── CTA.jsx
│   └── Footer.jsx
├── assets/
└── package.json          # when the stack is React/Next.js
```

## Examples

### AI product

```bash
saas-landing-page "CodeGenius" "AI-powered code generator for developers" \
  --template modern --stack nextjs --color purple
```

### B2B product

```bash
saas-landing-page "TeamSync" "Enterprise team collaboration platform" \
  --template b2b --stack react --color blue
```

### Developer tool

```bash
saas-landing-page "APIDoc" "Auto-generate API documentation" \
  --template developer --stack nextjs
```

## Included Components

- Hero section with primary CTA
- Features grid
- How It Works
- Pricing tables
- Testimonials
- Logo cloud
- FAQ section
- CTA banner
- Footer
- Mobile menu
- Loading animations

## SEO Defaults

Generated pages include:
- Meta tags (title, description, canonical).
- Open Graph + Twitter Card tags.
- Structured data (JSON-LD).
- Semantic HTML.
- Optimized image placeholders.
- Sitemap template.

## Supported Stacks

- Plain HTML / CSS
- React + CSS Modules
- React + Tailwind CSS
- Next.js + Tailwind
- Vue 3 + Tailwind

## Tools

| Tool | When to use |
| --- | --- |
| `sandbox_run_command` | Invoke the `saas-landing-page` script with the chosen template / stack / style flags. |
| `sandbox_write_file` | Persist generated components into the target app directory (e.g. `src/app/` for Next.js). |
| `sandbox_read_file` | Read existing design tokens / Tailwind config to align the generated palette. |
| `sandbox_list_files` | Confirm the output structure landed where the app expects it. |
| `requirements` | Read product name, one-line description, brand colors, stack preference from the requirement. |
| `requirement_status` | Publish the preview URL and usage instructions for the client. |

## Artifacts

- **Produces**: generated landing page folder (components, styles, assets) in the repo, plus any generated `package.json` when the stack is React/Next.js.
- **Consumes**: `requirement.instructions` sections 3 (Goals), 5 (Technical Guidelines — brand and stack), and the product description declared in section 1 (Overview).
