/**
 * Acceptance tokenizer + validator.
 *
 * Phase 10 rule: an acceptance entry is only considered **executable** (i.e.
 * something the Judge can match against evidence) when it contains at least
 * one concrete anchor:
 *
 *   - HTTP verb: GET | POST | PUT | DELETE | PATCH
 *   - Status code anchor: 2xx / 3xx / 4xx / 5xx or a literal 200..599
 *   - Route anchor: starts with `/` (e.g. `/api/bookings`, `/app/spaces`)
 *   - Observable verb: returns | renders | inserts | creates | deletes |
 *     updates | redirects | emits | saves | stores | accepts | rejects |
 *     responds
 *
 * Acceptance without any anchor is classified as **narrative** and rejected.
 * Narrative acceptance is the root cause of the "map-instead-of-product"
 * loop: entries like "Home shows product vision" trivially matched evidence
 * keywords and let the Judge approve a landing page as if it were the
 * functional deliverable.
 */

const VERB_RE = /\b(GET|POST|PUT|DELETE|PATCH)\b/;
const STATUS_CODE_RE = /\b([1-5]xx|[1-5]\d\d)\b/;
const ROUTE_RE = /(^|\s)\/[a-z0-9_\-/\[\]\.]+/i;
const OBSERVABLE_VERB_RE = /\b(returns?|renders?|inserts?|creates?|deletes?|updates?|redirects?|emits?|saves?|stores?|accepts?|rejects?|responds?|loads?|shows? the (form|table|list|dialog|modal|row)|opens? (a )?(modal|dialog|form)|dispatches?|persists?)\b/i;

export type AcceptanceAnchor =
  | { kind: 'http_verb'; value: string }
  | { kind: 'status_code'; value: string }
  | { kind: 'route'; value: string }
  | { kind: 'observable_verb'; value: string };

export interface AcceptanceAnalysis {
  text: string;
  anchors: AcceptanceAnchor[];
  executable: boolean;
}

export function analyzeAcceptanceEntry(text: string): AcceptanceAnalysis {
  const anchors: AcceptanceAnchor[] = [];

  const verb = text.match(VERB_RE);
  if (verb) anchors.push({ kind: 'http_verb', value: verb[1] });

  const status = text.match(STATUS_CODE_RE);
  if (status) anchors.push({ kind: 'status_code', value: status[1] });

  const route = text.match(ROUTE_RE);
  if (route) anchors.push({ kind: 'route', value: route[0].trim() });

  const obs = text.match(OBSERVABLE_VERB_RE);
  if (obs) anchors.push({ kind: 'observable_verb', value: obs[1] });

  return {
    text,
    anchors,
    executable: anchors.length > 0,
  };
}

export interface AcceptanceValidation {
  analyses: AcceptanceAnalysis[];
  executable: string[];
  narrative: string[];
  /** true iff at least one executable anchor is present across all entries. */
  has_any_executable: boolean;
}

export function validateAcceptance(acceptance: string[] | undefined | null): AcceptanceValidation {
  const analyses = (acceptance ?? []).map(analyzeAcceptanceEntry);
  const executable = analyses.filter((a) => a.executable).map((a) => a.text);
  const narrative = analyses.filter((a) => !a.executable).map((a) => a.text);
  return {
    analyses,
    executable,
    narrative,
    has_any_executable: executable.length > 0,
  };
}

/**
 * Derived route hints for probes + feature-coverage checks. Prefers explicit
 * `/foo` anchors in acceptance, then falls back to routes mined from
 * `touches[]` (e.g. `src/app/api/bookings/route.ts` → `/api/bookings`).
 */
export function routesFromAcceptance(acceptance: string[] | undefined | null): string[] {
  const out = new Set<string>();
  for (const line of acceptance ?? []) {
    const m = line.match(/\/[a-z0-9_\-/\[\]\.]+/gi);
    if (!m) continue;
    for (const r of m) {
      const cleaned = r.replace(/[.,)\]]+$/, '');
      if (cleaned.length > 1) out.add(cleaned);
    }
  }
  return Array.from(out);
}

export function routesFromTouches(touches: string[] | undefined | null): { pages: string[]; apis: string[] } {
  const pages = new Set<string>();
  const apis = new Set<string>();
  for (const t of touches ?? []) {
    // src/app/foo/bar/page.tsx → /foo/bar
    const page = t.match(/^src\/app\/(.+)\/page\.(tsx|jsx|ts|js)$/);
    if (page) {
      const seg = page[1]
        .split('/')
        .filter((s) => !(s.startsWith('(') && s.endsWith(')')));
      if (!seg.some((s) => s.startsWith('[') && s.endsWith(']'))) {
        pages.add('/' + seg.join('/'));
      }
      continue;
    }
    // src/app/api/foo/route.ts → /api/foo
    const api = t.match(/^src\/app\/api\/(.+)\/route\.(ts|js)$/);
    if (api) {
      const seg = api[1]
        .split('/')
        .filter((s) => !(s.startsWith('(') && s.endsWith(')')));
      if (!seg.some((s) => s.startsWith('[') && s.endsWith(']'))) {
        apis.add('/api/' + seg.join('/'));
      }
    }
  }
  return { pages: Array.from(pages), apis: Array.from(apis) };
}
