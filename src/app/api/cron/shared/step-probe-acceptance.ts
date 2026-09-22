import type { HttpMethod } from './step-runtime-probe';

type ProbeKind = 'page' | 'api';

function normalizeAcceptancePath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const path = value.trim().replace(/[),.;]+$/, '');
  if (!path.startsWith('/') || path.startsWith('//')) return null;
  return path.length > 1 ? path.replace(/\/+$/, '') : '/';
}

function routeTemplateMatches(
  template: string,
  concretePath: string,
): boolean {
  const templateParts = template.split('/');
  const concreteParts = concretePath.split('/');
  if (templateParts.length !== concreteParts.length) return false;
  return templateParts.every((part, index) =>
    part === concreteParts[index] ||
    /^:[a-z0-9_]+$/i.test(part) ||
    /^\[[^\]]+\]$/.test(part),
  );
}

function statusesFromStatement(statement: string): number[] {
  const clause = statement.match(
    /\b(?:returns?|responds?(?:\s+with)?|http)\s+(?:http\s+)?(?:status(?:\s+code)?\s+)?([1-5]\d{2}(?:\s*(?:,|\/|or|and)\s*[1-5]\d{2})*)\b/i,
  )?.[1];
  if (!clause) return [];
  return Array.from(clause.matchAll(/[1-5]\d{2}/g), (match) =>
    Number(match[0]));
}

export function expectedStatusesFromAcceptance(params: {
  acceptance?: string[];
  method: HttpMethod;
  path: string;
}): number[] | undefined {
  const statuses = new Set<number>();
  for (const statement of params.acceptance || []) {
    const routeMatch = statement.match(
      /\b(GET|POST|PUT|DELETE|PATCH)\s+(\/[^\s"'`<>]+)/i,
    );
    const method = routeMatch?.[1]?.toUpperCase() as HttpMethod | undefined;
    const route = normalizeAcceptancePath(routeMatch?.[2]);
    if (
      method !== params.method ||
      route == null ||
      !routeTemplateMatches(route, params.path)
    ) {
      continue;
    }
    for (const status of statusesFromStatement(statement)) {
      statuses.add(status);
    }
  }
  return statuses.size ? Array.from(statuses) : undefined;
}

function isAuthenticationBoundaryStatus(
  kind: ProbeKind,
  status: number,
): boolean {
  if (status === 401 || status === 403) return true;
  return kind === 'page' && [301, 302, 303, 307, 308].includes(status);
}

function sameStatuses(left: number[], right: number[]): boolean {
  return (
    left.length === right.length &&
    left.every((status) => right.includes(status))
  );
}

export function reconcileAcceptanceStatuses(params: {
  kind: ProbeKind;
  declared?: number[];
  acceptance?: number[];
}): {
  expected?: number[];
  authenticatedEvidenceRequired: boolean;
} {
  if (!params.acceptance?.length) {
    return {
      expected: params.declared,
      authenticatedEvidenceRequired: false,
    };
  }
  if (
    params.declared?.some((status) =>
      isAuthenticationBoundaryStatus(params.kind, status))
  ) {
    return {
      expected: params.declared,
      authenticatedEvidenceRequired: !sameStatuses(
        params.declared,
        params.acceptance,
      ),
    };
  }
  return {
    expected: params.acceptance,
    authenticatedEvidenceRequired: false,
  };
}
