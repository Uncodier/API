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

const VERB_GLOBAL_RE = /\b(GET|POST|PUT|DELETE|PATCH)\b/g;
const STATUS_CODE_GLOBAL_RE = /\b([1-5]xx|[1-5]\d\d)\b/gi;
const ROUTE_RE = /(^|[\s("'`])(\/[^\s,;"'`)]*)/gi;
const EXPLICIT_TEST_FILE_COMMAND_RE =
  /\b((?:npm|pnpm|yarn|bun)\s+(?:run\s+)?tests?\s+(?:--\s*)?[a-z0-9_./*[\]-]+\.(?:test|spec)\.[cm]?[jt]sx?)\b/i;
const COMMAND_RE =
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(build|tests?|lint|typecheck)\b|\b(build|tests?|lint|typecheck)\s+(?:command\s+)?(?:passes?|succeeds?|completes?\s+successfully)\b|\brun\s+(?:the\s+)?(build|tests?|lint|typecheck)\b|\bpruebas?\s+(?:de|del)\s+(build|tests?|lint|typecheck)\b|\b(?:correr|ejecutar)\s+(?:el\s+)?(build|tests?|lint|typecheck)\b/i;
const FILE_PATH_RE =
  /\b(?:src|app|docs|public|supabase|migrations|tests?|__tests__)\/[a-z0-9_./*[\]-]+\.[a-z0-9]{1,10}\b/gi;
const OBSERVABLE_VERB_RE = /\b(returns?|renders?|inserts?|creates?|deletes?|updates?|redirects?|emits?|saves?|stores?|accepts?|rejects?|responds?|resolves?|loads?|shows? the (form|table|list|dialog|modal|row)|opens? (a )?(modal|dialog|form)|dispatches?|persists?)\b/i;

export type AcceptanceAnchor =
  | { kind: 'http_verb'; value: string }
  | { kind: 'status_code'; value: string }
  | {
      kind: 'route';
      value: string;
      method?: string;
      status?: string;
    }
  | { kind: 'file_path'; value: string }
  | { kind: 'command'; value: string }
  | { kind: 'observable_verb'; value: string };

export interface AcceptanceAnalysis {
  text: string;
  anchors: AcceptanceAnchor[];
  executable: boolean;
}

interface RouteMatch {
  value: string;
  start: number;
  end: number;
}

function routeMatchesInText(text: string): RouteMatch[] {
  const routes: RouteMatch[] = [];
  for (const match of Array.from(text.matchAll(ROUTE_RE))) {
    const route = (match[2] || '').replace(/[.,;)]+$/, '');
    const start = (match.index ?? 0) + (match[1]?.length ?? 0);
    const rootHasRouteSyntax =
      start === 0 ||
      /\b(?:GET|POST|PUT|DELETE|PATCH)\s*$/.test(
        text.slice(Math.max(0, start - 16), start),
      ) ||
      /["'`(]/.test(text[start - 1] || '');
    if (
      !route ||
      route.startsWith('//') ||
      route.startsWith('/src/') ||
      route.startsWith('/public/') ||
      /\.[a-z0-9]{2,8}$/i.test(route) ||
      (route === '/' && !rootHasRouteSyntax)
    ) {
      continue;
    }
    const value = route.length > 1 ? route.replace(/\/+$/, '') : route;
    routes.push({ value, start, end: start + route.length });
  }
  return routes;
}

function routesInText(text: string): string[] {
  return Array.from(new Set(
    routeMatchesInText(text).map((route) => route.value),
  ));
}

export function analyzeAcceptanceEntry(text: string): AcceptanceAnalysis {
  const anchors: AcceptanceAnchor[] = [];

  const verbs = Array.from(text.matchAll(VERB_GLOBAL_RE));
  const statuses = Array.from(text.matchAll(STATUS_CODE_GLOBAL_RE));
  for (const verb of verbs) {
    anchors.push({ kind: 'http_verb', value: verb[1].toUpperCase() });
  }
  for (const status of statuses) {
    anchors.push({ kind: 'status_code', value: status[1].toLowerCase() });
  }

  const routeMatches = routeMatchesInText(text);
  const usesRespectively =
    /\brespectively\b/i.test(text) &&
    statuses.length === routeMatches.length;
  routeMatches.forEach((route, index) => {
    const previousRouteEnd = index > 0 ? routeMatches[index - 1].end : 0;
    const nextRouteStart =
      routeMatches[index + 1]?.start ?? text.length;
    const precedingVerbs = verbs.filter((verb) => {
      const verbIndex = verb.index ?? -1;
      return verbIndex >= previousRouteEnd && verbIndex < route.start;
    });
    const followingStatuses = statuses.filter((status) => {
      const statusIndex = status.index ?? -1;
      return statusIndex >= route.end && statusIndex < nextRouteStart;
    });
    anchors.push({
      kind: 'route',
      value: route.value,
      method:
        precedingVerbs.at(-1)?.[1].toUpperCase() ||
        (verbs.length === 1 ? verbs[0][1].toUpperCase() : undefined),
      status:
        (usesRespectively
          ? statuses[index]?.[1].toLowerCase()
          : followingStatuses[0]?.[1].toLowerCase()) ||
        (statuses.length === 1 ? statuses[0][1].toLowerCase() : undefined),
    });
  });

  for (const path of text.match(FILE_PATH_RE) || []) {
    anchors.push({ kind: 'file_path', value: path });
  }

  const explicitTestCommand = text.match(EXPLICIT_TEST_FILE_COMMAND_RE);
  const command = explicitTestCommand || text.match(COMMAND_RE);
  if (command) {
    const commandName = explicitTestCommand?.[1] ||
      command.slice(1).find(Boolean)!;
    anchors.push({
      kind: 'command',
      value: explicitTestCommand
        ? commandName.toLowerCase().replace(/\s+/g, ' ').trim()
        : commandName.toLowerCase().replace(/s$/, ''),
    });
  }

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
    routesInText(line).forEach((route) => out.add(route));
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
