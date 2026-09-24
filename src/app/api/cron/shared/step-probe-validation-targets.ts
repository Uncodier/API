import {
  analyzeProbeRoutePath,
} from '@/lib/services/acceptance-route-path';
import type {
  AcceptanceTargetResolution,
} from '@/lib/services/requirement-evidence-types';
import type { HttpMethod } from './step-runtime-probe';
import type {
  ProbeObservation,
  StepValidationTarget,
} from './step-probe-types';

const METHODS = new Set<HttpMethod>([
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
]);

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

export function stepTargetResolution(
  target: StepValidationTarget,
): AcceptanceTargetResolution {
  const method = target.kind === 'api'
    ? target.method || 'GET'
    : undefined;
  return {
    criterion_id:
      `step-validation:${target.kind}:${method || 'GET'}:${target.path}`,
    kind: target.kind,
    path: target.path,
    ...(method ? { method } : {}),
    status: 'declared',
    strategy: 'step_validation_target',
    required: true,
  };
}

export function inspectStepValidationTargets(value: unknown): {
  targets: StepValidationTarget[];
  observations: ProbeObservation[];
} {
  if (!Array.isArray(value)) return { targets: [], observations: [] };
  const targets: StepValidationTarget[] = [];
  const observations: ProbeObservation[] = [];

  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') continue;
    const raw = candidate as Record<string, unknown>;
    if (raw.kind !== 'page' && raw.kind !== 'api') continue;
    const route = analyzeProbeRoutePath(raw.path, raw.kind);
    const methodRaw =
      typeof raw.method === 'string' ? raw.method.toUpperCase() : 'GET';
    const method = METHODS.has(methodRaw as HttpMethod)
      ? methodRaw as HttpMethod
      : null;
    if (!route.valid || !route.executable || !route.normalized || !method) {
      const path = typeof raw.path === 'string' ? raw.path : String(raw.path);
      const criterionId =
        `step-validation:${raw.kind}:${methodRaw}:${path}`;
      const resolution: AcceptanceTargetResolution = {
        criterion_id: criterionId,
        kind: raw.kind,
        path,
        ...(raw.kind === 'api' && method
          ? { method }
          : {}),
        status: route.valid ? 'template_unresolved' : 'invalid',
        strategy: 'step_validation_target',
        required: false,
        detail: !method
          ? `Unsupported HTTP method "${methodRaw}".`
          : route.reason,
      };
      observations.push({
        kind: 'contract',
        disposition: 'unknown',
        source: 'contract',
        target:
          raw.kind === 'api' ? `${methodRaw} ${path}` : path,
        detail: `Invalid validation target: ${resolution.detail}`,
        ...(method ? { method } : {}),
        criterion_id: criterionId,
        target_resolution: resolution,
      });
      continue;
    }
    targets.push({
      kind: raw.kind,
      path: route.normalized,
      ...(raw.kind === 'api' ? { method } : {}),
      ...(normalizeStatuses(raw.expected_statuses)
        ? { expected_statuses: normalizeStatuses(raw.expected_statuses) }
        : {}),
      ...(raw.payload !== undefined ? { payload: raw.payload } : {}),
      ...(typeof raw.auth_required === 'boolean'
        ? { auth_required: raw.auth_required }
        : {}),
    });
  }
  return { targets, observations };
}

export function normalizeStepValidationTargets(
  value: unknown,
): StepValidationTarget[] {
  return inspectStepValidationTargets(value).targets;
}
