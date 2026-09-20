import type {
  HttpMethod,
  RuntimeApiProbe,
  RuntimePageProbe,
  RuntimeProbeResult,
} from './step-runtime-probe';

export type ProbeDisposition =
  | 'pass'
  | 'hard_fail'
  | 'unknown'
  | 'advisory';

export type ProbeTargetSource =
  | 'contract'
  | 'protected_route'
  | 'diff'
  | 'prose'
  | 'default';

export interface StepValidationTarget {
  kind: 'page' | 'api';
  path: string;
  method?: HttpMethod;
  expected_statuses?: number[];
  payload?: unknown;
}

export interface RuntimePageTarget {
  kind: 'page';
  path: string;
  source: ProbeTargetSource;
  required: boolean;
  expected_statuses?: number[];
}

export interface RuntimeApiTarget {
  kind: 'api';
  path: string;
  method: HttpMethod;
  source: ProbeTargetSource;
  required: boolean;
  expected_statuses?: number[];
  payload?: unknown;
}

export interface ProbeObservation {
  kind: 'runtime' | 'page' | 'api' | 'visual' | 'console' | 'copy' | 'scenario';
  disposition: ProbeDisposition;
  source: ProbeTargetSource;
  target?: string;
  detail: string;
  method?: HttpMethod;
  http_status?: number;
  expected_statuses?: number[];
}

export interface RuntimeTargetPlan {
  pages: RuntimePageTarget[];
  apis: RuntimeApiTarget[];
  observations: ProbeObservation[];
}

const METHODS = new Set<HttpMethod>(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']);

function normalizePath(value: unknown, kind?: 'page' | 'api'): string | null {
  if (typeof value !== 'string') return null;
  const path = value.trim().replace(/[),.;:]+$/, '');
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('[')) {
    return null;
  }
  if (
    path.startsWith('/src/') ||
    path.startsWith('/public/') ||
    /\.[a-z0-9]{2,8}$/i.test(path)
  ) {
    return null;
  }
  if (kind === 'api' && !path.startsWith('/api/')) return null;
  if (kind === 'page' && path.startsWith('/api/')) return null;
  return path.length > 1 ? path.replace(/\/+$/, '') : '/';
}

function normalizeStatuses(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const statuses = Array.from(new Set(
    value.filter(
      (status): status is number =>
        Number.isInteger(status) && status >= 100 && status <= 599,
    ),
  ));
  return statuses.length ? statuses : undefined;
}

export function normalizeStepValidationTargets(
  value: unknown,
): StepValidationTarget[] {
  if (!Array.isArray(value)) return [];
  const targets: StepValidationTarget[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') continue;
    const raw = candidate as Record<string, unknown>;
    if (raw.kind !== 'page' && raw.kind !== 'api') continue;
    const path = normalizePath(raw.path, raw.kind);
    if (!path) continue;
    const methodRaw =
      typeof raw.method === 'string' ? raw.method.toUpperCase() : 'GET';
    const method = METHODS.has(methodRaw as HttpMethod)
      ? methodRaw as HttpMethod
      : 'GET';
    targets.push({
      kind: raw.kind,
      path,
      ...(raw.kind === 'api' ? { method } : {}),
      ...(normalizeStatuses(raw.expected_statuses)
        ? { expected_statuses: normalizeStatuses(raw.expected_statuses) }
        : {}),
      ...(raw.payload !== undefined ? { payload: raw.payload } : {}),
    });
  }
  return targets;
}

function upsertPage(
  targetMap: Map<string, RuntimePageTarget>,
  target: RuntimePageTarget,
): void {
  const existing = targetMap.get(target.path);
  if (!existing || (!existing.required && target.required)) {
    targetMap.set(target.path, target);
  }
}

function upsertApi(
  targetMap: Map<string, RuntimeApiTarget>,
  target: RuntimeApiTarget,
): void {
  const key = `${target.method} ${target.path}`;
  const existing = targetMap.get(key);
  if (!existing || (!existing.required && target.required)) {
    targetMap.set(key, target);
  }
}

export function buildRuntimeTargetPlan(input: {
  validationTargets?: unknown;
  protectedRoutes?: string[];
  proseRoutes?: string[];
  inferredPageRoutes?: string[];
  inferredApiRoutes?: Array<{ path: string; method?: HttpMethod }>;
}): RuntimeTargetPlan {
  const pages = new Map<string, RuntimePageTarget>();
  const apis = new Map<string, RuntimeApiTarget>();
  const observations: ProbeObservation[] = [];

  for (const target of normalizeStepValidationTargets(input.validationTargets)) {
    if (target.kind === 'page') {
      upsertPage(pages, {
        ...target,
        kind: 'page',
        source: 'contract',
        required: true,
      });
      continue;
    }
    upsertApi(apis, {
      ...target,
      kind: 'api',
      method: target.method || 'GET',
      source: 'contract',
      required: true,
    });
  }

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
    const disposition: ProbeDisposition = unavailable
      ? 'unknown'
      : failed
        ? target?.required
          ? 'hard_fail'
          : 'advisory'
        : 'pass';
    observations.push({
      kind: 'api',
      disposition,
      source,
      target: key,
      detail: `HTTP ${probe.http_status}`,
      method: probe.method,
      http_status: probe.http_status,
      expected_statuses: target?.expected_statuses,
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
