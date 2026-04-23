/**
 * Copy hygiene check.
 *
 * Scans the HTML `body_snippet` of every page hit by the runtime probe and
 * blocks the gate when the rendered output leaks orchestrator-internal
 * taxonomy into user-facing copy. The recurring failure mode this guards
 * against is the consumer building a "landing about the backlog item"
 * instead of the actual product — e.g. a home page that paraphrases the
 * backlog item title and prints its UUID as a section subtitle.
 *
 * No fancy NLP: a small allowlist of literal patterns that have ZERO
 * legitimate reason to surface in a generated app's HTML body.
 */

import type { RuntimePageProbe } from './step-runtime-probe';

interface HygieneRule {
  pattern: RegExp;
  label: string;
  hint: string;
}

const FORBIDDEN_PATTERNS: HygieneRule[] = [
  {
    pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
    label: 'UUID literal in user-facing copy',
    hint: 'Never render `item_id` / `requirement_id` UUIDs to end users. Replace with real product copy.',
  },
  {
    pattern:
      /\b(item[_\s-]?id|requirement[_\s-]?id|scope[_\s-]?level|phase[_\s-]?id|backlog\s+item|feature[_\s-]?list|spec\.md|requirement\.spec|progress\.md|evidence\/)\b/i,
    label: 'orchestrator-internal token',
    hint: 'These strings belong to the orchestrator state, not the product UI. Remove them from the rendered copy.',
  },
  {
    pattern: /\btier\s*[:=]\s*['"]?(core|ornamental)\b/i,
    label: 'tier metadata leaked into copy',
    hint: 'Tier is a backlog flag, not a product label. Remove it from the rendered copy.',
  },
  {
    pattern:
      /(El\s+item\s+[0-9a-f-]{8,}|Resumen\s+del\s+backlog|queda\s+resumido|landing\s+visible\s+y\s+construible|construible\s+en\s+['"`/]|Backlog\s+summary|Item\s+(?:resumen|summary):)/i,
    label: 'meta-prose about the backlog',
    hint: 'The route must showcase the actual product (real users, real value prop, real CTAs), not narrate which backlog item produced it.',
  },
  {
    pattern: /\b(lorem\s+ipsum|placeholder\s+(?:text|copy)|coming\s+soon\s+\(placeholder\)|TODO\s*:|TBD\s*:)\b/i,
    label: 'placeholder copy',
    hint: 'Replace with real copy aligned to the requirement (audience, value prop, CTAs).',
  },
];

export interface CopyHygieneIssue {
  path: string;
  pattern_label: string;
  matched: string;
  snippet: string;
  hint: string;
}

export interface CopyHygieneResult {
  ok: boolean;
  issues: CopyHygieneIssue[];
}

/**
 * Run the hygiene rules over every page probe with an HTML body. Returns
 * `ok=true` when every page is clean (or had nothing rendered to inspect).
 */
export function detectCopyHygieneIssues(pages: RuntimePageProbe[]): CopyHygieneResult {
  const issues: CopyHygieneIssue[] = [];

  for (const page of pages) {
    if (!page.body_snippet) continue;
    if (!isHtmlLike(page.content_type, page.body_snippet)) continue;
    if (page.http_status >= 400 || page.http_status === 0) continue;

    const text = stripHtml(page.body_snippet);
    if (!text) continue;

    for (const rule of FORBIDDEN_PATTERNS) {
      const match = text.match(rule.pattern);
      if (!match) continue;
      issues.push({
        path: page.path,
        pattern_label: rule.label,
        matched: match[0].slice(0, 120),
        snippet: text.slice(0, 240),
        hint: rule.hint,
      });
    }
  }

  return { ok: issues.length === 0, issues };
}

/** Compact human-readable summary used as the gate's `error` field. */
export function summarizeCopyHygiene(result: CopyHygieneResult): string {
  if (result.ok) return 'copy hygiene OK';
  const head = `${result.issues.length} copy-hygiene leak(s) — internal taxonomy or meta-prose surfaced in rendered HTML. Fix the rendered copy, do NOT rename the backlog item.`;
  const lines = result.issues.slice(0, 6).map(
    (i) => `  - ${i.path} → ${i.pattern_label}: "${i.matched}" | ${i.hint}`,
  );
  return [head, ...lines].join('\n');
}

function isHtmlLike(contentType: string | undefined, body: string): boolean {
  if (contentType && /html/i.test(contentType)) return true;
  return /<\/?(html|head|body|main|section|article|div|p|h1|h2|h3)\b/i.test(body);
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
