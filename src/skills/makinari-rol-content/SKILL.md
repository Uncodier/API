---
name: makinari-rol-content
description: Content creation skill for copy, articles, emails, and SEO content delivered through Makinari tools or the repository.
types: ['content', 'marketing_campaign']
---

# SKILL: makinari-rol-content

## Objective
Create copy, articles, emails, and SEO content. Deliver through the appropriate Makinari channel.

## Environment
- Tools: `requirements`, `requirement_status`, `content`, `campaigns`, `sandbox_write_file`

## Execution Rules

### 1. Delivery Routes
- **Email sequences / Outreach:** Save via the `campaigns` or site settings tools. NEVER in generic `content`.
- **Articles, Blogs, Ebooks:** Save via the `content` tool with the correct `type` (`blog_post`, `ebook`, etc.).
- **Web / Landing Pages:** If type is "develop", use the sandbox + git flow (write files to `/vercel/sandbox`).

### 2. Content Quality
- Follow the structure required by the requirement. If Markdown is requested, use semantically correct headings, lists, and bold text.
- Check spelling, coherence, and brand tone.
- No placeholder text (Lorem Ipsum). All content must be final and complete.

### 3. Brand Context
- Before writing, use the `memories` tool to check for brand guidelines and tone associated with the site.
- If site settings contain brand info, incorporate it into your writing.

### 4. Reporting
- Use `requirement_status` tool to report delivery with links to the content or preview URLs.
- Mark your plan step as completed via `instance_plan` tool.
