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

export interface EvidenceRecord {
  schema_version: 1;
  item_id: string;
  evidence_run_id?: string;
  captured_at: string;
  tests?: {
    command: string;
    exit_code: number;
    output_tail: string;
    ran_after_changes: boolean;
    captured_at?: string;
  }[];
  build?: { command: string; exit_code: number; duration_ms: number };
  runtime?: { route: string; http_status: number; screenshot_url?: string };
  scenarios?: { name: string; pass: boolean; duration_ms: number }[];
  changed_files?: string[];
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
  }>;
  critic_passes: number;
  judge_verdict?: 'approved' | 'rejected' | 'escalate';
  judge_reason?: string;
  judge_failure_kind?: 'product_defect' | 'evidence_gap' | 'contract_error';
  judge_matched_acceptance?: string[];
  judge_unmatched_acceptance?: string[];
}
