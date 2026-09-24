import type {
  HttpMethod,
  RuntimeApiProbe,
  RuntimePageProbe,
  RuntimeProbeResult,
} from './step-runtime-probe';
import {
  authRequiredFromAcceptance,
  expectedStatusesFromAcceptance,
  reconcileAcceptanceStatuses,
} from './step-probe-acceptance';
import { sanitizeRuntimeLog } from './runtime-log-context';
import { deriveAcceptanceProbeTargets } from './step-probe-contract-targets';
import type {
  AcceptanceContract,
} from '@/lib/services/requirement-acceptance-contract';
import {
  analyzeProbeRoutePath,
} from '@/lib/services/acceptance-route-path';
import {
  inspectStepValidationTargets,
  stepTargetResolution,
} from './step-probe-validation-targets';
import type {
  ProbeDisposition,
  ProbeObservation,
  ProbeTargetSource,
  RuntimeApiTarget,
  RuntimePageTarget,
  RuntimeTargetPlan,
} from './step-probe-types';

export { expectedStatusesFromAcceptance } from './step-probe-acceptance';
export {
  normalizeStepValidationTargets,
} from './step-probe-validation-targets';
export type {
  ProbeDisposition,
  ProbeObservation,
  ProbeObservationSource,
  ProbeTargetSource,
  RuntimeApiTarget,
  RuntimePageTarget,
  RuntimeTargetPlan,
  StepValidationTarget,
} from './step-probe-types';

function normalizePath(value: unknown, kind?: 'page' | 'api'): string | null {
  const route = analyzeProbeRoutePath(value, kind);
  if (!route.valid || !route.executable || !route.normalized) return null;
  const path = route.normalized;
  return path.length > 1 ? path.replace(/\/+$/, '') : '/';
}

function upsertPage(
  targetMap: Map<string, RuntimePageTarget>,
  target: RuntimePageTarget,
): void {
  const existing = targetMap.get(target.path);
  if (!existing) {
    targetMap.set(target.path, target);
    return;
  }
  const incomingDeclared =
    target.target_resolution?.strategy === 'declared_contract';
  const existingDeclared =
    existing.target_resolution?.strategy === 'declared_contract';
  if (
    (!existing.required && target.required) ||
    (incomingDeclared && !existingDeclared)
  ) {
    targetMap.set(target.path, {
      ...existing,
      ...target,
      expected_statuses:
        target.expected_statuses || existing.expected_statuses,
    });
  }
}

function upsertApi(
  targetMap: Map<string, RuntimeApiTarget>,
  target: RuntimeApiTarget,
): void {
  const key = `${target.method} ${target.path}`;
  const existing = targetMap.get(key);
  if (!existing) {
    targetMap.set(key, target);
    return;
  }
  const incomingDeclared =
    target.target_resolution?.strategy === 'declared_contract';
  const existingDeclared =
    existing.target_resolution?.strategy === 'declared_contract';
  if (
    (!existing.required && target.required) ||
    (incomingDeclared && !existingDeclared)
  ) {
    targetMap.set(key, {
      ...existing,
      ...target,
      expected_statuses:
        target.expected_statuses || existing.expected_statuses,
      payload: target.payload ?? existing.payload,
    });
  }
}

function resolveContractStatuses(params: {
  kind: 'page' | 'api';
  path: string;
  method: HttpMethod;
  declared?: number[];
  acceptance?: string[];
  acceptanceContract?: AcceptanceContract;
  observations: ProbeObservation[];
}): number[] | undefined {
  const acceptanceStatuses = expectedStatusesFromAcceptance({
    acceptance: params.acceptance,
    acceptanceContract: params.acceptanceContract,
    method: params.method,
    path: params.path,
  });
  const resolved = reconcileAcceptanceStatuses({
    kind: params.kind,
    declared: params.declared,
    acceptance: acceptanceStatuses,
  });
  if (resolved.authenticatedEvidenceRequired) {
    params.observations.push({
      kind: params.kind,
      disposition: 'advisory',
      source: 'contract',
      target:
        params.kind === 'api'
          ? `${params.method} ${params.path}`
          : params.path,
      detail:
        `Backlog acceptance expects HTTP ${acceptanceStatuses?.join(', ')}, ` +
        `but this unauthenticated probe permits HTTP ${params.declared?.join(', ')}. ` +
        'Verify the success response with authenticated scenario or test evidence.',
      method: params.method,
      expected_statuses: acceptanceStatuses,
    });
  }
  return resolved.expected;
}

export function buildRuntimeTargetPlan(input: {
  validationTargets?: unknown;
  acceptance?: string[];
  acceptanceContract?: AcceptanceContract;
  protectedRoutes?: string[];
  proseRoutes?: string[];
  inferredPageRoutes?: string[];
  inferredApiRoutes?: Array<{ path: string; method?: HttpMethod }>;
  restrictContractTargetsToValidation?: boolean;
}): RuntimeTargetPlan {
  const pages = new Map<string, RuntimePageTarget>();
  const apis = new Map<string, RuntimeApiTarget>();
  const observations: ProbeObservation[] = [];

  const declaredTargets = inspectStepValidationTargets(
    input.validationTargets,
  );
  observations.push(...declaredTargets.observations);
  for (const target of declaredTargets.targets) {
    const resolution = stepTargetResolution(target);
    if (target.kind === 'page') {
      const expectedStatuses = resolveContractStatuses({
        kind: 'page',
        path: target.path,
        method: 'GET',
        declared: target.expected_statuses,
        acceptance: input.acceptance,
        acceptanceContract: input.acceptanceContract,
        observations,
      });
      upsertPage(pages, {
        ...target,
        kind: 'page',
        source: 'contract',
        required: true,
        criterion_id: resolution.criterion_id,
        target_resolution: resolution,
        ...(expectedStatuses
          ? { expected_statuses: expectedStatuses }
          : {}),
      });
      continue;
    }
    const expectedStatuses = resolveContractStatuses({
      kind: 'api',
      path: target.path,
      method: target.method || 'GET',
      declared: target.expected_statuses,
      acceptance: input.acceptance,
      acceptanceContract: input.acceptanceContract,
      observations,
    });
    const authRequired =
      target.auth_required ??
      authRequiredFromAcceptance({
        acceptance: input.acceptance,
        acceptanceContract: input.acceptanceContract,
        method: target.method || 'GET',
        path: target.path,
      });
    upsertApi(apis, {
      ...target,
      kind: 'api',
      method: target.method || 'GET',
      source: 'contract',
      required: true,
      criterion_id: resolution.criterion_id,
      target_resolution: resolution,
      auth_required: authRequired,
      ...(expectedStatuses
        ? { expected_statuses: expectedStatuses }
        : {}),
    });
  }

  const acceptanceTargets = deriveAcceptanceProbeTargets({
    acceptance: input.acceptance,
    acceptanceContract: input.acceptanceContract,
    declaredPages: Array.from(pages.values()),
    declaredApis: Array.from(apis.values()),
    restrictToDeclaredTargets:
      input.restrictContractTargetsToValidation,
  });
  acceptanceTargets.pages.forEach((target) => upsertPage(pages, target));
  acceptanceTargets.apis.forEach((target) => upsertApi(apis, target));
  observations.push(...acceptanceTargets.observations);

  for (const pathValue of input.protectedRoutes || []) {
    const path = normalizePath(pathValue, 'page');
    if (!path) continue;
    upsertPage(pages, {
      kind: 'page',
      path,
      source: 'protected_route',
      required: true,
      expected_statuses: [200, 301, 302, 303, 307, 308, 401, 403],
    });
  }
  for (const pathValue of input.proseRoutes || []) {
    const path = normalizePath(pathValue, 'page');
    if (!path) continue;
    upsertPage(pages, {
      kind: 'page',
      path,
      source: 'prose',
      required: false,
    });
  }
  for (const pathValue of input.inferredPageRoutes || []) {
    const path = normalizePath(pathValue, 'page');
    if (!path) continue;
    upsertPage(pages, {
      kind: 'page',
      path,
      source: 'diff',
      required: false,
    });
  }
  for (const target of input.inferredApiRoutes || []) {
    const path = normalizePath(target.path, 'api');
    if (!path) continue;
    const method = target.method || 'GET';
    if (method !== 'GET') {
      observations.push({
        kind: 'api',
        disposition: 'advisory',
        source: 'diff',
        target: `${method} ${path}`,
        detail:
          'Inferred non-GET route was not called without an explicit payload.',
      });
      continue;
    }
    upsertApi(apis, {
      kind: 'api',
      path,
      method,
      source: 'diff',
      required: false,
    });
  }

  return {
    pages: Array.from(pages.values()),
    apis: Array.from(apis.values()),
    observations,
  };
}

function isSoftPageFailure(probe: RuntimePageProbe): boolean {
  const body = probe.body_snippet?.toLowerCase() || '';
  return (
    body.includes('this page could not be found') ||
    body.includes('application error') ||
    body.includes('404 page not found')
  );
}

function statusMatches(status: number, expected?: number[]): boolean {
  return expected?.length
    ? expected.includes(status)
    : status >= 200 && status < 400;
}

export function evaluateRuntimeProbe(
  result: RuntimeProbeResult,
  plan: RuntimeTargetPlan,
): {
  hardFailure: boolean;
  observations: ProbeObservation[];
  pages: RuntimePageProbe[];
  apis: RuntimeApiProbe[];
} {
  const observations = [...plan.observations];
  const pageTargets = new Map(plan.pages.map((target) => [target.path, target]));
  const apiTargets = new Map(
    plan.apis.map((target) => [`${target.method} ${target.path}`, target]),
  );

  const pages = result.pages.map((probe) => {
    const target = pageTargets.get(probe.path);
    const source = target?.source || 'default';
    const unavailable = probe.http_status === 0;
    const failed =
      !unavailable &&
      (!statusMatches(probe.http_status, target?.expected_statuses) ||
        isSoftPageFailure(probe));
    const disposition: ProbeDisposition = unavailable
      ? 'unknown'
      : failed
        ? target?.required
          ? 'hard_fail'
          : 'advisory'
        : 'pass';
    observations.push({
      kind: 'page',
      disposition,
      source,
      target: probe.path,
      detail: `HTTP ${probe.http_status}${isSoftPageFailure(probe) ? ' (soft error page)' : ''}`,
      method: 'GET',
      http_status: probe.http_status,
      expected_statuses: target?.expected_statuses,
      criterion_id: target?.criterion_id,
      target_resolution: target?.target_resolution,
    });
    return {
      ...probe,
      validation_source: source,
      validation_disposition: disposition,
      validation_required: target?.required === true,
    };
  });

  const apis = result.apis.map((probe) => {
    const key = `${probe.method} ${probe.path}`;
    const target = apiTargets.get(key);
    const source = target?.source || 'diff';
    const unavailable = probe.http_status === 0;
    const failed =
      !unavailable &&
      !statusMatches(probe.http_status, target?.expected_statuses);
    const unauthenticatedBoundary =
      failed &&
      target?.auth_required === true &&
      (probe.http_status === 401 || probe.http_status === 403);
    let disposition: ProbeDisposition = 'pass';
    if (unavailable) {
      disposition = 'unknown';
    } else if (failed) {
      disposition =
        unauthenticatedBoundary || !target?.required
          ? 'advisory'
          : 'hard_fail';
    }
    const bodyExcerpt = sanitizeRuntimeLog(probe.body_snippet)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300);
    observations.push({
      kind: 'api',
      disposition,
      source,
      target: key,
      detail:
        `HTTP ${probe.http_status}` +
        (unauthenticatedBoundary
          ? ' (unauthenticated probe reached an authentication boundary; require authenticated test or scenario evidence)'
          : '') +
        (bodyExcerpt ? `; body=${bodyExcerpt}` : ''),
      method: probe.method,
      http_status: probe.http_status,
      expected_statuses: target?.expected_statuses,
      criterion_id: target?.criterion_id,
      target_resolution: target?.target_resolution,
    });
    return {
      ...probe,
      validation_source: source,
      validation_disposition: disposition,
      validation_required: target?.required === true,
    };
  });

  for (const target of plan.pages) {
    if (pages.some((probe) => probe.path === target.path)) continue;
    observations.push({
      kind: 'page',
      disposition: 'unknown',
      source: target.source,
      target: target.path,
      detail: 'The planned page probe produced no result.',
      method: 'GET',
      expected_statuses: target.expected_statuses,
      criterion_id: target.criterion_id,
      target_resolution: target.target_resolution,
    });
  }
  for (const target of plan.apis) {
    if (
      apis.some(
        (probe) =>
          probe.path === target.path && probe.method === target.method,
      )
    ) {
      continue;
    }
    observations.push({
      kind: 'api',
      disposition: 'unknown',
      source: target.source,
      target: `${target.method} ${target.path}`,
      detail: 'The planned API probe produced no result.',
      method: target.method,
      expected_statuses: target.expected_statuses,
      criterion_id: target.criterion_id,
      target_resolution: target.target_resolution,
    });
  }

  if (result.startup_error) {
    observations.push({
      kind: 'runtime',
      disposition: 'hard_fail',
      source: 'contract',
      detail: result.startup_error,
    });
  }
  for (const error of result.server_errors) {
    const blocking = [
      'module_not_found',
      'unhandled_rejection',
      'uncaught_exception',
      'syntax_error',
      'type_error',
      'hydration_mismatch',
    ].includes(error.kind);
    observations.push({
      kind: 'runtime',
      disposition: blocking ? 'hard_fail' : 'advisory',
      source: 'contract',
      detail: `${error.kind}: ${error.line}`,
    });
  }

  return {
    hardFailure: observations.some(
      (observation) => observation.disposition === 'hard_fail',
    ),
    observations,
    pages,
    apis,
  };
}
