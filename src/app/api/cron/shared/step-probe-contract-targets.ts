import {
  isDeclaredAcceptanceContract,
  resolveAcceptanceContract,
  type AcceptanceContract,
} from '@/lib/services/requirement-acceptance-contract';
import {
  analyzeProbeRoutePath,
  routeTemplateMatches,
} from '@/lib/services/acceptance-route-path';
import {
  expandExpectedHttpStatus,
} from '@/lib/services/acceptance-http-status';
import type {
  AcceptanceTargetResolution,
} from '@/lib/services/requirement-evidence-types';
import type { HttpMethod } from './step-runtime-probe';
import type {
  ProbeObservation,
  ProbeTargetSource,
  RuntimeApiTarget,
  RuntimePageTarget,
} from './step-probe-types';

interface ContractPageTarget {
  kind: 'page';
  path: string;
  source: ProbeTargetSource;
  required: boolean;
  expected_statuses?: number[];
  criterion_id: string;
  target_resolution: AcceptanceTargetResolution;
}

interface ContractApiTarget {
  kind: 'api';
  path: string;
  method: HttpMethod;
  source: ProbeTargetSource;
  required: boolean;
  auth_required: boolean;
  expected_statuses?: number[];
  payload?: unknown;
  criterion_id: string;
  target_resolution: AcceptanceTargetResolution;
}

function literalStatus(expected: string | undefined): number[] | undefined {
  return expandExpectedHttpStatus(expected);
}

function targetResolution(params: {
  criterionId: string;
  kind: 'page' | 'api';
  path: string;
  method?: HttpMethod;
  declared: boolean;
  status: AcceptanceTargetResolution['status'];
  detail?: string;
}): AcceptanceTargetResolution {
  return {
    criterion_id: params.criterionId,
    kind: params.kind,
    path: params.path,
    ...(params.method ? { method: params.method } : {}),
    status: params.status,
    strategy: params.declared
      ? 'declared_contract'
      : 'legacy_parser',
    required: params.declared && params.status === 'declared',
    ...(params.detail ? { detail: params.detail } : {}),
  };
}

export function deriveAcceptanceProbeTargets(params: {
  acceptance?: string[];
  acceptanceContract?: AcceptanceContract;
  declaredPages: RuntimePageTarget[];
  declaredApis: RuntimeApiTarget[];
  restrictToDeclaredTargets?: boolean;
}): {
  pages: ContractPageTarget[];
  apis: ContractApiTarget[];
  observations: ProbeObservation[];
} {
  const pages: ContractPageTarget[] = [];
  const apis: ContractApiTarget[] = [];
  const observations: ProbeObservation[] = [];
  const contract = resolveAcceptanceContract(
    params.acceptance || [],
    params.acceptanceContract,
  );
  const declared = isDeclaredAcceptanceContract(contract);
  const source: ProbeTargetSource = declared
    ? 'contract'
    : 'contract_inferred';

  for (const criterion of contract.criteria) {
    for (const claim of criterion.all_of) {
      if (
        claim.kind !== 'page_response' &&
        claim.kind !== 'internal_link' &&
        claim.kind !== 'http_response'
      ) {
        continue;
      }
      if (claim.kind === 'internal_link' && !claim.path) continue;
      const kind = claim.kind === 'http_response' ? 'api' : 'page';
      const path = claim.path!;
      const method: HttpMethod =
        claim.kind === 'http_response' ? claim.method : 'GET';
      const route = analyzeProbeRoutePath(path);
      const resolvedPage = kind === 'page'
        ? params.declaredPages.find((target) =>
            routeTemplateMatches(path, target.path))
        : undefined;
      const resolvedApi = kind === 'api'
        ? params.declaredApis.find((target) =>
            target.method === method &&
            routeTemplateMatches(path, target.path))
        : undefined;
      if (
        params.restrictToDeclaredTargets &&
        !resolvedPage &&
        !resolvedApi
      ) {
        continue;
      }
      const concretePath =
        resolvedPage?.path ||
        resolvedApi?.path ||
        (route.executable ? route.normalized : undefined);
      const status: AcceptanceTargetResolution['status'] = !route.valid
        ? 'invalid'
        : !concretePath
          ? 'template_unresolved'
          : declared
            ? 'declared'
            : 'legacy_inferred';
      const resolution = targetResolution({
        criterionId: criterion.id,
        kind,
        path: concretePath || route.normalized || path,
        ...(kind === 'api' ? { method } : {}),
        declared,
        status,
        detail: !route.executable && concretePath
          ? `Resolved route template ${path} with declared target ${concretePath}.`
          : route.reason,
      });
      if (!route.valid || !concretePath) {
        observations.push({
          kind: 'contract',
          disposition: 'unknown',
          source,
          target: kind === 'api' ? `${method} ${path}` : path,
          detail: !route.valid
            ? `Invalid acceptance target: ${route.reason}`
            : 'Acceptance target is a route template and no concrete fixture was declared.',
          method,
          criterion_id: criterion.id,
          target_resolution: resolution,
        });
        continue;
      }
      if (claim.kind === 'page_response') {
        pages.push({
          kind: 'page',
          path: concretePath,
          source,
          required: resolution.required,
          ...(literalStatus(claim.expected_status)
            ? { expected_statuses: literalStatus(claim.expected_status) }
            : {}),
          criterion_id: criterion.id,
          target_resolution: resolution,
        });
        continue;
      }
      if (claim.kind === 'internal_link' && claim.path) {
        pages.push({
          kind: 'page',
          path: concretePath,
          source,
          required: resolution.required,
          criterion_id: criterion.id,
          target_resolution: resolution,
        });
        continue;
      }
      if (claim.kind !== 'http_response') continue;
      const key = `${claim.method} ${concretePath}`;
      const expectedStatuses = literalStatus(claim.expected_status);
      const declaredApi = params.declaredApis.find(
        (target) =>
          target.method === claim.method &&
          target.path === concretePath,
      );
      if (
        claim.method !== 'GET' &&
        !declaredApi
      ) {
        observations.push({
          kind: 'api',
          disposition: 'unknown',
          source,
          target: key,
          detail:
            'Acceptance target was not called because no request payload fixture was declared.',
          method: claim.method,
          ...(expectedStatuses
            ? { expected_statuses: expectedStatuses }
            : {}),
          criterion_id: criterion.id,
          target_resolution: resolution,
        });
        continue;
      }
      apis.push({
        kind: 'api',
        path: concretePath,
        method: claim.method,
        source,
        required: resolution.required,
        auth_required: claim.auth === 'required',
        ...(expectedStatuses
          ? { expected_statuses: expectedStatuses }
          : {}),
        ...(declaredApi && 'payload' in declaredApi
          ? { payload: declaredApi.payload }
          : {}),
        criterion_id: criterion.id,
        target_resolution: resolution,
      });
    }
  }

  return { pages, apis, observations };
}
