import type { HttpMethod } from './step-runtime-probe';

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

export type ProbeObservationSource = ProbeTargetSource | 'agent_probe';

export interface StepValidationTarget {
  kind: 'page' | 'api';
  path: string;
  method?: HttpMethod;
  expected_statuses?: number[];
  payload?: unknown;
  auth_required?: boolean;
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
  auth_required?: boolean;
}

export interface ProbeObservation {
  kind: 'runtime' | 'page' | 'api' | 'visual' | 'console' | 'copy' | 'scenario';
  disposition: ProbeDisposition;
  source: ProbeObservationSource;
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
