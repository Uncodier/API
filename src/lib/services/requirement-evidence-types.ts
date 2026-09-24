import type { AcceptanceClaim } from './requirement-acceptance-contract';

export type AcceptanceGapCode =
  | 'criterion_not_executable'
  | 'unsupported_compound_obligation'
  | 'missing_http_observation'
  | 'missing_page_observation'
  | 'missing_request_payload'
  | 'authentication_context_missing'
  | 'http_status_mismatch'
  | 'invalid_target'
  | 'inferred_target_unconfirmed'
  | 'route_template_unresolved'
  | 'missing_interaction_audit'
  | 'missing_internal_link'
  | 'missing_link_content'
  | 'route_not_reachable'
  | 'missing_file_artifact'
  | 'file_not_changed'
  | 'missing_command_receipt'
  | 'missing_semantic_receipt';

export type AcceptanceGapClass =
  | 'product'
  | 'evidence'
  | 'contract'
  | 'capability';

export interface AcceptanceEvidenceGap {
  code: AcceptanceGapCode;
  class: AcceptanceGapClass;
  message: string;
  required: string;
  observed?: string[];
  suggested_action: string;
}

export interface AcceptanceCriterionDiagnostic {
  criterion_id: string;
  criterion: string;
  status: 'matched' | 'contradicted' | 'missing';
  claims: AcceptanceClaim[];
  gaps: AcceptanceEvidenceGap[];
}

export interface FeatureCoverageEvidence {
  ok: boolean;
  evaluable?: boolean;
  declared_touches?: string[];
  present_touches?: string[];
  missing_touches?: string[];
  not_evaluable_touches?: string[];
  expected_page_routes?: string[];
  expected_api_routes?: string[];
  present_page_files?: string[];
  present_api_files?: string[];
  not_evaluable_page_routes?: string[];
  not_evaluable_api_routes?: string[];
  acceptance_route_anchors?: string[];
  artifact_proofs?: Array<{
    path: string;
    exists: boolean;
    outcome?: 'pass' | 'fail' | 'not_evaluable';
    bytes?: number;
    content_excerpt?: string;
    error?: string;
  }>;
  kind_requirements?: Array<{
    kind: string;
    requirement: string;
    satisfied: boolean;
    outcome?: 'pass' | 'fail' | 'not_evaluable';
    detail?: string;
  }>;
  probe_errors?: Array<{ target: string; detail: string }>;
  summary?: string;
}

export interface InteractionEvidence {
  ok: boolean;
  evaluable?: boolean;
  audited_files?: string[];
  links?: Array<{
    file: string;
    line: number;
    element: string;
    target: string;
    region: 'header' | 'footer' | 'navigation' | 'other';
    route_exists: boolean;
    source_binding?: string;
    content_excerpt?: string;
  }>;
  unresolved_links?: Array<{
    file: string;
    line: number;
    element: string;
    region: 'header' | 'footer' | 'navigation' | 'other';
    source_binding?: string;
  }>;
  findings?: Array<{
    kind: string;
    file: string;
    line: number;
    target?: string;
    reason: string;
    confidence: string;
    disposition: string;
  }>;
  blocking_count?: number;
  deferred_count?: number;
  warning_count?: number;
  summary?: string;
}

export interface AcceptanceTargetResolution {
  criterion_id: string;
  kind: 'page' | 'api';
  path: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  status:
    | 'declared'
    | 'legacy_inferred'
    | 'invalid'
    | 'template_unresolved';
  strategy:
    | 'declared_contract'
    | 'step_validation_target'
    | 'legacy_parser';
  required: boolean;
  detail?: string;
}

export type ScenarioAssertionReceipt =
  | {
      kind: 'http_response';
      pass: boolean;
      method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
      target: string;
      actual_status: number;
      expected_statuses: number[];
    }
  | {
      kind: 'dom_assertion';
      pass: boolean;
      selector: string;
      assertion:
        | 'exists'
        | 'not_exists'
        | 'text_contains'
        | 'text_equals'
        | 'min_count'
        | 'max_count'
        | 'attribute_equals'
        | 'attribute_contains';
      expected?: string | number;
      actual?: string | number;
    };

export interface EvidenceRecord {
  schema_version: 1;
  item_id: string;
  evidence_run_id?: string;
  producer_step_id?: string;
  workspace_fingerprint?: string;
  captured_at: string;
  tests?: {
    command: string;
    exit_code: number;
    output_tail: string;
    ran_after_changes: boolean;
    captured_at?: string;
    step_id?: string;
    workspace_fingerprint?: string;
  }[];
  build?: { command: string; exit_code: number; duration_ms: number };
  runtime?: { route: string; http_status: number; screenshot_url?: string };
  scenarios?: { name: string; pass: boolean; duration_ms: number }[];
  scenario_assertions?: ScenarioAssertionReceipt[];
  changed_files?: string[];
  target_resolutions?: AcceptanceTargetResolution[];
  feature_coverage?: FeatureCoverageEvidence;
  interaction?: InteractionEvidence;
  commit_sha?: string;
  assumptions_logged?: string[];
  observations?: Array<{
    kind: string;
    disposition: 'pass' | 'hard_fail' | 'unknown' | 'advisory';
    source: string;
    target?: string;
    detail: string;
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    http_status?: number;
    expected_statuses?: number[];
    criterion_id?: string;
    target_resolution?: AcceptanceTargetResolution;
  }>;
  critic_passes: number;
  judge_verdict?: 'approved' | 'rejected' | 'escalate';
  judge_reason?: string;
  judge_failure_kind?:
    | 'product_defect'
    | 'evidence_gap'
    | 'contract_error'
    | 'capability_gap';
  judge_matched_acceptance?: string[];
  judge_unmatched_acceptance?: string[];
  judge_acceptance_diagnostics?: AcceptanceCriterionDiagnostic[];
  gate_resume?: {
    status: 'pending';
    step_id: string;
    workspace_fingerprint: string;
    captured_at: string;
  } | null;
}
