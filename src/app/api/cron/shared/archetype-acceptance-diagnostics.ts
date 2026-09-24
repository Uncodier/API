import type {
  AcceptanceClaim,
  AcceptanceContractV1,
} from '@/lib/services/requirement-acceptance-contract';
import type {
  AcceptanceCriterionDiagnostic,
  AcceptanceEvidenceGap,
  EvidenceRecord,
} from '@/lib/services/requirement-evidence-types';

type CriterionStatus = AcceptanceCriterionDiagnostic['status'];

function normalizedRoute(value: string): string {
  return value.toLowerCase().replace(/\/+$/, '') || '/';
}

function observationMatches(
  target: string | undefined,
  path: string,
  method: string,
  structuredMethod?: string,
): boolean {
  if (!target) return false;
  const match = target.match(/^(GET|POST|PUT|PATCH|DELETE)\s+/i);
  const observedMethod =
    structuredMethod?.toUpperCase() ||
    match?.[1]?.toUpperCase() ||
    'GET';
  if (observedMethod !== method.toUpperCase()) return false;
  const observedPath = normalizedRoute(
    target.replace(/^(?:GET|POST|PUT|PATCH|DELETE)\s+/i, ''),
  );
  const expectedPath = normalizedRoute(path);
  const observedParts = observedPath.split('/');
  const expectedParts = expectedPath.split('/');
  return observedParts.length === expectedParts.length &&
    expectedParts.every((part, index) =>
      part.startsWith(':') ||
      /^\[[^\]]+\]$/.test(part) ||
      part === observedParts[index],
    );
}

function statusMatches(status: number, expected?: string): boolean {
  if (!expected) return status >= 200 && status < 400;
  if (/^[1-5]xx$/i.test(expected)) {
    return Math.floor(status / 100) === Number(expected[0]);
  }
  return status === Number(expected);
}

function expectedRouteText(
  claim: Extract<AcceptanceClaim, { kind: 'http_response' | 'page_response' }>,
): string {
  const method = claim.kind === 'http_response' ? claim.method : 'GET';
  return `${method} ${claim.path}` +
    (claim.expected_status ? ` returns ${claim.expected_status}` : ' succeeds');
}

function routeGaps(
  claim: Extract<AcceptanceClaim, { kind: 'http_response' | 'page_response' }>,
  evidence: EvidenceRecord,
): AcceptanceEvidenceGap[] {
  const method = claim.kind === 'http_response' ? claim.method : 'GET';
  const observations = (evidence.observations || []).filter((observation) =>
    observationMatches(
      observation.target,
      claim.path,
      method,
      observation.method,
    ),
  );
  if (
    claim.kind === 'page_response' &&
    evidence.runtime &&
    normalizedRoute(evidence.runtime.route) === normalizedRoute(claim.path)
  ) {
    observations.push({
      kind: 'page',
      disposition: statusMatches(
        evidence.runtime.http_status,
        claim.expected_status,
      )
        ? 'pass'
        : 'hard_fail',
      source: 'runtime',
      target: claim.path,
      detail: `HTTP ${evidence.runtime.http_status}`,
      method: 'GET',
      http_status: evidence.runtime.http_status,
    });
  }
  if (observations.some((observation) =>
    observation.disposition === 'pass' &&
    observation.http_status !== undefined &&
    statusMatches(observation.http_status, claim.expected_status),
  )) {
    return [];
  }

  const observed = observations.map((observation) =>
    `${observation.disposition}: ${observation.method || method} ` +
    `${observation.target || claim.path} ${observation.http_status ?? ''} ` +
    `${observation.detail}`.trim(),
  );
  const authBoundary = observations.find((observation) =>
    observation.http_status === 401 || observation.http_status === 403,
  );
  if (authBoundary || (
    claim.kind === 'http_response' &&
    claim.auth === 'required' &&
    observations.length === 0
  )) {
    return [{
      code: 'authentication_context_missing',
      class: 'capability',
      message:
        'The required authenticated success response cannot be collected by the current probe context.',
      required: expectedRouteText(claim),
      observed: observed.length ? observed : ['No authenticated observation was produced.'],
      suggested_action:
        'Provide a credential-backed auth profile or authenticated E2E scenario; do not change product code based only on this gap.',
    }];
  }

  const payloadMissing = observations.find((observation) =>
    /payload|non-get route was not called/i.test(observation.detail),
  );
  if (payloadMissing || (
    claim.kind === 'http_response' &&
    claim.method !== 'GET' &&
    observations.length === 0
  )) {
    return [{
      code: 'missing_request_payload',
      class: 'evidence',
      message: 'The non-GET route was not exercised with a declared request fixture.',
      required: expectedRouteText(claim),
      observed,
      suggested_action:
        'Declare a validation target with a real payload or run a deterministic submit scenario.',
    }];
  }

  if (observations.length === 0) {
    return [{
      code:
        claim.kind === 'http_response'
          ? 'missing_http_observation'
          : 'missing_page_observation',
      class: 'evidence',
      message: 'No matching runtime receipt was collected.',
      required: expectedRouteText(claim),
      suggested_action:
        'Add this route to the step validation targets and collect a fresh runtime receipt.',
    }];
  }

  return [{
    code: 'http_status_mismatch',
    class: observations.some((observation) =>
      observation.disposition === 'hard_fail')
      ? 'product'
      : 'evidence',
    message: 'Observed responses do not satisfy the acceptance status.',
    required: expectedRouteText(claim),
    observed,
    suggested_action:
      'Inspect the response and server log; repair the route only when the receipt confirms a product defect.',
  }];
}

function linkGaps(
  claim: Extract<AcceptanceClaim, { kind: 'internal_link' }>,
  evidence: EvidenceRecord,
): AcceptanceEvidenceGap[] {
  const interaction = evidence.interaction;
  const required =
    `${claim.region || 'internal'} link` +
    `${claim.path ? ` to ${claim.path}` : ''}`;
  if (!interaction?.evaluable) {
    return [{
      code: 'missing_interaction_audit',
      class: 'evidence',
      message: 'No evaluable static interaction receipt was collected.',
      required,
      suggested_action: 'Run the interaction audit against the current workspace.',
    }];
  }
  const regionEvidence = [
    ...(interaction.links || []),
    ...(interaction.unresolved_links || []),
  ].some((link) =>
    !claim.region ||
    link.region === claim.region ||
    (claim.region === 'navigation' && link.region === 'header'),
  );
  if (!regionEvidence) {
    return [{
      code: 'missing_interaction_audit',
      class: 'evidence',
      message: 'The audit did not observe links in the requested region.',
      required,
      suggested_action:
        'Collect a fresh interaction receipt for the requested navigation region.',
    }];
  }
  const candidates = (interaction.links || []).filter((link) =>
    (!claim.path || normalizedRoute(link.target) === normalizedRoute(claim.path)) &&
    (
      !claim.region ||
      link.region === claim.region ||
      (claim.region === 'navigation' && link.region === 'header')
    ),
  );
  if (candidates.length === 0) {
    return [{
      code: 'missing_internal_link',
      class: (interaction.unresolved_links || []).length > 0
        ? 'evidence'
        : 'product',
      message: 'The required link was not found in the requested region.',
      required,
      observed: (interaction.links || []).slice(0, 10).map((link) =>
        `${link.region} ${link.element} -> ${link.target}`),
      suggested_action:
        'Inspect the audited source binding; repair it only if the link is actually absent.',
    }];
  }
  if (candidates.some((link) => !link.route_exists)) {
    return [{
      code: 'route_not_reachable',
      class: 'product',
      message: 'The link target does not resolve to an application route.',
      required,
      observed: candidates.map((link) =>
        `${link.file}:${link.line} -> ${link.target} route_exists=${link.route_exists}`),
      suggested_action: 'Repair the href or create the intended route.',
    }];
  }
  if (
    claim.requires_content &&
    !candidates.some((link) => !!link.content_excerpt?.trim())
  ) {
    return [{
      code: 'missing_link_content',
      class: 'evidence',
      message: 'The link exists, but the audit did not capture the wrapped content.',
      required,
      observed: candidates.map((link) => `${link.file}:${link.line} -> ${link.target}`),
      suggested_action:
        'Collect a fresh interaction receipt containing the link child-content excerpt.',
    }];
  }
  return [];
}

function gapsForClaim(
  claim: AcceptanceClaim,
  evidence: EvidenceRecord,
): AcceptanceEvidenceGap[] {
  if (claim.kind === 'http_response' || claim.kind === 'page_response') {
    return routeGaps(claim, evidence);
  }
  if (claim.kind === 'internal_link') return linkGaps(claim, evidence);
  if (claim.kind === 'unsupported_obligation') {
    return [{
      code: claim.reason === 'narrative'
        ? 'criterion_not_executable'
        : 'unsupported_compound_obligation',
      class: 'contract',
      message:
        claim.reason === 'narrative'
          ? 'The criterion has no executable evidence contract.'
          : `The independent obligation "${claim.text}" needs its own acceptance claim.`,
      required: claim.text,
      suggested_action:
        'Split or rewrite the criterion into independently executable claims without weakening the requested behavior.',
    }];
  }
  if (claim.kind === 'file_artifact') {
    const proof = evidence.feature_coverage?.artifact_proofs?.find(
      (artifact) => artifact.path === claim.path,
    );
    if (!proof?.exists) {
      return [{
        code: 'missing_file_artifact',
        class: 'product',
        message: 'The required file artifact was not found.',
        required: claim.path,
        suggested_action: 'Create or restore the required artifact.',
      }];
    }
    if (!(evidence.changed_files || []).includes(claim.path)) {
      return [{
        code: 'file_not_changed',
        class: 'evidence',
        message: 'The artifact exists but is not part of the current change set.',
        required: claim.path,
        suggested_action: 'Verify the intended baseline instead of making a cosmetic edit.',
      }];
    }
    return [];
  }
  if (claim.kind === 'command') {
    const passed = claim.command === 'build'
      ? evidence.build?.exit_code === 0
      : (evidence.tests || []).some((test) =>
          test.exit_code === 0 &&
          test.ran_after_changes &&
          (
            claim.command === 'test' ||
            test.command.toLowerCase().includes(claim.command.toLowerCase())
          ));
    return passed ? [] : [{
      code: 'missing_command_receipt',
      class: 'evidence',
      message: 'The required command has no fresh passing receipt.',
      required: claim.command,
      suggested_action: 'Run the exact bounded command declared by the contract.',
    }];
  }
  return [{
    code: 'missing_semantic_receipt',
    class: 'evidence',
    message: 'No structured browser or runtime assertion proves this behavior.',
    required: claim.text,
    suggested_action: 'Collect a typed DOM, HTTP, or database assertion for the behavior.',
  }];
}

export function buildAcceptanceDiagnostics(params: {
  contract: AcceptanceContractV1;
  evidence: EvidenceRecord;
  matched: string[];
  contradicted: string[];
}): AcceptanceCriterionDiagnostic[] {
  const matched = new Set(params.matched);
  const contradicted = new Set(params.contradicted);
  return params.contract.criteria.map((criterion) => {
    const status: CriterionStatus = matched.has(criterion.text)
      ? 'matched'
      : contradicted.has(criterion.text)
        ? 'contradicted'
        : 'missing';
    return {
      criterion_id: criterion.id,
      criterion: criterion.text,
      status,
      claims: criterion.all_of,
      gaps: status === 'matched'
        ? []
        : criterion.all_of.flatMap((claim) =>
            gapsForClaim(claim, params.evidence)),
    };
  });
}
