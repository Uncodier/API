---
name: makinari-rol-content
description: Content role. Produces copy, articles, emails, SEO content, and brand-aligned text deliverables through the correct Makinari channel (content tool, campaigns tool, or sandbox files for web copy).
types: ['content', 'marketing_campaign']
---

# SKILL: makinari-rol-content

## Objective

Produce final, client-ready content and deliver it through the right channel. A piece of content is not "done" until it is:
- Aligned with the brand voice captured during investigation.
- Free of placeholders (Lorem Ipsum, `[insert here]`, TODO).
- Stored in the correct system (content tool, campaigns tool, or the repo Vitrina).

## Execution Rules

### 1. Pull brand context first
Before writing, use the `memories` tool to pull:
- Brand voice, tone, forbidden terms.
- Prior content for this site (avoid repetition).
- Audience and language preference.

If the requirement references a site, also read its site settings for language, tone, and locale.

### 2. Delivery channel matrix

Pick the channel by requirement type and content kind:

| Content kind | Requirement type | Channel | Tool / action |
| --- | --- | --- | --- |
| Blog post, ebook, long-form article | `content` | Content store | `content` tool with `type="blog_post"` / `"ebook"` |
| Landing copy / website pages (ships with UI) | `develop` + `content` | Repo files (Vitrina or app) | `sandbox_write_file` into the page/component |
| Email sequence / outreach cadence | `marketing_campaign` | Campaigns store | `campaigns` tool (NEVER generic `content` for emails) |
| SEO metadata for existing pages | `develop` | Page head / metadata | `sandbox_write_file` into the page; reference `website-seo` for rules |
| Brand guidelines snapshot | `content` | Content store | `content` tool with the closest applicable `type`, or `memories` if it's context for future agents |
| One-off report / insight in Markdown | `task` | Vitrina | Hand off to `makinari-obj-tarea` |

**Rules**
- NEVER put outreach / email sequences in the generic `content` tool. Campaigns has its own type.
- NEVER store brand guidelines as a regular article — either use the campaigns / site settings surface or leave them in `memories`.

### 3. Content quality floor
- Respect structure requested by the requirement (headings, callouts, lists).
- Use markdown semantically (`#` for H1, `##` for H2, ordered vs unordered lists used intentionally).
- Check spelling, grammar, coherence in the target language.
- No placeholder text. Every section is final.

### 4. SEO hygiene (when applicable)
When the content is for a web page or blog post:
- Title tag 50-60 chars, includes primary keyword.
- Meta description 150-160 chars, includes primary keyword + soft CTA.
- Exactly one H1 with the primary keyword.
- 2-3 internal links to related pages, 1 external link to an authoritative source.
- Alt text on every image.

Reference `website-seo` for deeper SEO rules.

### 5. Language rule
- Default output language matches the site / brand (most Uncodie clients expect Spanish).
- If the requirement is written in English but the brand targets another language, use the brand language for the deliverable and keep internal notes in English.

### 6. Reporting
- Use `requirement_status` to report delivery with links to the stored content or preview URL.
- Mark the plan step completed via `instance_plan action="execute_step"`.

## Tools

| Tool | When to use |
| --- | --- |
| `content` | Store articles, blog posts, ebooks with the right `type`. |
| `campaigns` | Store email sequences and outreach cadences (never use `content` for these). |
| `memories` | Pull brand voice, prior decisions, forbidden terms before writing. |
| `requirements` | Read requirement sections 3 (Goals) and 5 (Technical Guidelines) for structure. |
| `sandbox_write_file` | Write web copy directly into page files or Vitrina `data.json`. |
| `sandbox_read_file` | Inspect existing content before updating to preserve voice. |
| `requirement_status` | Report delivery link. |
| `instance_plan` | Report step status via `action="execute_step"`. |

## Artifacts

- **Produces**: content records (via `content`), campaign records (via `campaigns`), or updated repo files under `src/app/**` / Vitrina `data.json`.
- **Consumes**: brand memories, site settings, requirement section 5 (Technical Guidelines — tone, structure) and section 3 (Goals).

## Anti-patterns

- Storing outreach emails in `content`. Use `campaigns`.
- Writing generic "SEO-friendly" content without a declared primary keyword.
- Leaving Lorem Ipsum because "the client can replace it later". No placeholders ship.
- Ignoring brand voice captured in `memories`.
