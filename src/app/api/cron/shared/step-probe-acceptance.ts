import type { HttpMethod } from './step-runtime-probe';
import type {
  AcceptanceContract,
} from '@/lib/services/requirement-acceptance-contract';
import {
  analyzeAcceptanceRoutePath,
  routeTemplateMatches,
} from '@/lib/services/acceptance-route-path';
import {
  expandExpectedHttpStatus,
} from '@/lib/services/acceptance-http-status';

type ProbeKind = 'page' | 'api';

function normalizeAcceptancePath(value: unknown): string | null {
  const route = analyzeAcceptanceRoutePath(value);
  return route.valid ? route.normalized || null : null;
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
  acceptanceContract?: AcceptanceContract;
  method: HttpMethod;
  path: string;
}): number[] | undefined {
  const statuses = new Set<number>();
  if (params.acceptanceContract) {
    for (const criterion of params.acceptanceContract.criteria) {
      for (const claim of criterion.all_of) {
        const method = claim.kind === 'http_response' ? claim.method : 'GET';
        if (
          (claim.kind !== 'http_response' &&
            claim.kind !== 'page_response') ||
          method !== params.method ||
          !routeTemplateMatches(claim.path, params.path)
        ) {
          continue;
        }
        for (
          const status of expandExpectedHttpStatus(
            claim.expected_status,
          ) || []
        ) {
          statuses.add(status);
        }
      }
    }
    return statuses.size ? Array.from(statuses) : undefined;
  }
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

export function authRequiredFromAcceptance(params: {
  acceptance?: string[];
  acceptanceContract?: AcceptanceContract;
  method: HttpMethod;
  path: string;
}): boolean {
  if (params.acceptanceContract) {
    return params.acceptanceContract.criteria.some((criterion) =>
      criterion.all_of.some((claim) =>
        claim.kind === 'http_response' &&
        claim.method === params.method &&
        claim.auth === 'required' &&
        routeTemplateMatches(claim.path, params.path),
      ),
    );
  }
  return (params.acceptance || []).some((statement) => {
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
      return false;
    }
    return /\b(?:requires?\s+auth(?:entication)?|auth(?:entication)?\s+required|authenticated\s+(?:users?|requests?)|authorized\s+(?:users?|requests?)|signed[- ]in\s+users?|protected\s+(?:api|endpoint|route))\b/i.test(
      statement,
    );
  });
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
