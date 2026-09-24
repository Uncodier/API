import type { HttpMethod } from './step-runtime-probe';
import type {
  AcceptanceTargetResolution,
} from '@/lib/services/requirement-evidence-types';

export type ProbeDisposition =
  | 'pass'
  | 'hard_fail'
  | 'unknown'
  | 'advisory';

export type ProbeTargetSource =
  | 'contract'
  | 'contract_inferred'
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
  criterion_id?: string;
  target_resolution?: AcceptanceTargetResolution;
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
  criterion_id?: string;
  target_resolution?: AcceptanceTargetResolution;
}

export interface ProbeObservation {
  kind:
    | 'runtime'
    | 'page'
    | 'api'
    | 'visual'
    | 'console'
    | 'copy'
    | 'scenario'
    | 'contract';
  disposition: ProbeDisposition;
  source: ProbeObservationSource;
  target?: string;
  detail: string;
  method?: HttpMethod;
  http_status?: number;
  expected_statuses?: number[];
  criterion_id?: string;
  target_resolution?: AcceptanceTargetResolution;
}

export interface RuntimeTargetPlan {
  pages: RuntimePageTarget[];
  apis: RuntimeApiTarget[];
  observations: ProbeObservation[];
}
