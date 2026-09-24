import {
  type AcceptanceAnchor,
  type AcceptanceAnalysis,
} from '@/lib/services/requirement-acceptance';
import type { EvidenceRecord } from '@/lib/services/requirement-ground-truth';
import {
  resolveAcceptanceContract,
  type AcceptanceClaim,
  type AcceptanceContract,
} from '@/lib/services/requirement-acceptance-contract';
import {
  routeTemplateMatches,
} from '@/lib/services/acceptance-route-path';
import type {
  AcceptanceCriterionDiagnostic,
} from '@/lib/services/requirement-evidence-types';
import {
  genericEvidenceReceipts,
  genericProofTerms,
} from './archetype-generic-evidence';
import {
  evaluateContractLinkClaims,
} from './archetype-contract-link-evidence';
import { buildAcceptanceDiagnostics } from './archetype-acceptance-diagnostics';

type RouteAnchor = Extract<AcceptanceAnchor, { kind: 'route' }>;
type ContractCriterion = AcceptanceContract['criteria'][number];

function analysisFromClaims(
  text: string,
  claims: AcceptanceClaim[],
): AcceptanceAnalysis {
  const anchors: AcceptanceAnchor[] = [];
  for (const claim of claims) {
    if (claim.kind === 'http_response') {
      anchors.push({ kind: 'http_verb', value: claim.method });
      anchors.push({
        kind: 'route',
        value: claim.path,
        method: claim.method,
        status: claim.expected_status,
      });
    }
    if (claim.kind === 'page_response') {
      anchors.push({
        kind: 'route',
        value: claim.path,
        method: 'GET',
        status: claim.expected_status,
      });
    }
    if (claim.kind === 'internal_link' && claim.path) {
      anchors.push({ kind: 'route', value: claim.path });
    }
    if (claim.kind === 'file_artifact') {
      anchors.push({ kind: 'file_path', value: claim.path });
    }
    if (claim.kind === 'command') {
      anchors.push({ kind: 'command', value: claim.command });
    }
  }
  return {
    text,
    anchors,
    executable:
      claims.length > 0 &&
      !claims.some(
        (claim) => claim.kind === 'unsupported_obligation',
      ),
  };
}

function analysisFromContract(
  criterion: ContractCriterion,
): AcceptanceAnalysis {
  return analysisFromClaims(criterion.text, criterion.all_of);
}

function normalized(value: string): string {
  return value.trim().toLowerCase().replace(/\/+$/, '');
}

function expectedHttpMethod(
  analysis: AcceptanceAnalysis,
  route?: string,
  explicitAnchor?: RouteAnchor,
): string | undefined {
  const routeAnchor = explicitAnchor || analysis.anchors.find(
    (anchor) => anchor.kind === 'route' && anchor.value === route,
  );
  if (routeAnchor?.kind === 'route' && routeAnchor.method) {
    return routeAnchor.method.toUpperCase();
  }
  const methods = Array.from(new Set(
    analysis.anchors
      .filter((anchor) => anchor.kind === 'http_verb')
      .map((anchor) => anchor.value.toUpperCase()),
  ));
  return methods.length === 1 ? methods[0] : undefined;
}

function expectedStatus(
  analysis: AcceptanceAnalysis,
  route?: string,
  explicitAnchor?: RouteAnchor,
): string | undefined {
  const routeAnchor = explicitAnchor || analysis.anchors.find(
    (anchor) => anchor.kind === 'route' && anchor.value === route,
  );
  if (routeAnchor?.kind === 'route' && routeAnchor.status) {
    return routeAnchor.status.toLowerCase();
  }
  const statuses = Array.from(new Set(
    analysis.anchors
      .filter((anchor) => anchor.kind === 'status_code')
      .map((anchor) => anchor.value.toLowerCase()),
  ));
  return statuses.length === 1 ? statuses[0] : undefined;
}

function statusMatchesExpected(
  status: number,
  expected: string | undefined,
): boolean {
  if (!expected) return status >= 200 && status < 400;
  if (/^[1-5]xx$/.test(expected)) {
    return Math.floor(status / 100) === Number(expected[0]);
  }
  return status === Number(expected);
}

function observationMatchesRoute(
  target: string | undefined,
  route: string,
  expectedMethod?: string,
  structuredMethod?: string,
): boolean {
  if (!target) return false;
  const methodMatch = target.match(
    /^(GET|POST|PUT|PATCH|DELETE)\s+/i,
  );
  const observedMethod =
    structuredMethod?.toUpperCase() ||
    methodMatch?.[1].toUpperCase() ||
    'GET';
  if (expectedMethod && observedMethod !== expectedMethod) return false;
  const targetPath = normalized(
    target.replace(/^(?:GET|POST|PUT|PATCH|DELETE)\s+/i, ''),
  );
  const expected = normalized(route);
  return targetPath === expected || routeTemplateMatches(expected, targetPath);
}

function hasRouteContradiction(
  analysis: AcceptanceAnalysis,
  route: string,
  evidence: EvidenceRecord,
  routeAnchor?: RouteAnchor,
): boolean {
  const method = expectedHttpMethod(analysis, route, routeAnchor);
  return (evidence.observations || []).some(
    (observation) =>
      observation.disposition === 'hard_fail' &&
      observationMatchesRoute(
        observation.target,
        route,
        method,
        observation.method,
      ),
  );
}

function observationHttpStatus(detail: string): number | undefined {
  const match = detail.match(/\bHTTP\s+([1-5]\d\d)\b/i);
  return match ? Number(match[1]) : undefined;
}

function hasRouteProof(
  analysis: AcceptanceAnalysis,
  route: string,
  evidence: EvidenceRecord,
  routeAnchor?: RouteAnchor,
): boolean {
  if (
    hasRouteContradiction(analysis, route, evidence, routeAnchor)
  ) {
    return false;
  }
  const method = expectedHttpMethod(analysis, route, routeAnchor);
  const status = expectedStatus(analysis, route, routeAnchor);
  if (
    (!method || method === 'GET') &&
    evidence.runtime &&
    observationMatchesRoute(evidence.runtime.route, route) &&
    statusMatchesExpected(evidence.runtime.http_status, status)
  ) {
    return true;
  }
  if (
    (evidence.observations || []).some(
      (observation) =>
        observation.disposition === 'pass' &&
        observationMatchesRoute(
          observation.target,
          route,
          method,
          observation.method,
        ) &&
        (
          !status ||
          (
            (
              observation.http_status ??
              observationHttpStatus(observation.detail)
            ) !== undefined &&
            statusMatchesExpected(
              (
                observation.http_status ??
                observationHttpStatus(observation.detail)
              )!,
              status,
            )
          )
        ),
    )
  ) {
    return true;
  }
  return false;
}

function hasFileProof(
  path: string,
  analysis: AcceptanceAnalysis,
  evidence: EvidenceRecord,
): boolean {
  const expected = normalized(path.replace(/^\.?\//, ''));
  const artifact = (evidence.feature_coverage?.artifact_proofs || [])
    .find((proof) => normalized(proof.path.replace(/^\.?\//, '')) === expected);
  if (
    !artifact?.exists ||
    artifact.outcome === 'not_evaluable' ||
    (artifact.bytes ?? 0) <= 0
  ) {
    return false;
  }
  const changed = new Set(
    (evidence.changed_files || []).map((file) =>
      normalized(file.replace(/^\.?\//, '')),
    ),
  );
  if (!changed.has(expected)) return false;

  const criterionWithoutPath = analysis.text
    .replace(path, ' ')
    .toLowerCase();
  const semanticTerms = criterionWithoutPath
    .match(/[a-z0-9_-]{4,}/g)
    ?.filter((term) =>
      ![
        'create', 'creates', 'created', 'update', 'updates', 'updated',
        'file', 'with', 'that', 'this', 'from', 'into', 'containing',
        'contains', 'include', 'includes', 'return', 'returns',
      ].includes(term),
    ) || [];
  if (semanticTerms.length === 0) return true;
  const content = (artifact.content_excerpt || '').toLowerCase();
  const hits = semanticTerms.filter((term) => content.includes(term)).length;
  return hits >= Math.min(2, semanticTerms.length);
}

function hasCommandProof(
  command: string,
  evidence: EvidenceRecord,
): boolean {
  if (command === 'build') return evidence.build?.exit_code === 0;
  const expectedCommand = command.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!expectedCommand) return false;
  return (evidence.tests || []).some((test) =>
    test.exit_code === 0 &&
    test.ran_after_changes &&
    (
      command === 'test' ||
      test.command.toLowerCase().replace(/\s+/g, ' ')
        .includes(expectedCommand)
    ),
  );
}

function hasCommandContradiction(
  command: string,
  evidence: EvidenceRecord,
): boolean {
  if (command === 'build') {
    return !!evidence.build && evidence.build.exit_code !== 0;
  }
  const expectedCommand = command.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!expectedCommand) return false;
  return (evidence.tests || []).some((test) =>
    test.exit_code !== 0 &&
    (
      command === 'test' ||
      test.command.toLowerCase().replace(/\s+/g, ' ')
        .includes(expectedCommand)
    ),
  );
}

type ClaimEvidenceResult = 'pass' | 'fail' | 'unknown';

function semanticAssertionHasProof(
  text: string,
  haystacks: string[],
): boolean {
  const proofTerms = genericProofTerms({
    text,
    anchors: [],
    executable: true,
  });
  return proofTerms.length >= 2 && haystacks.some((haystack) => {
    let hits = 0;
    for (const term of proofTerms) {
      if (haystack.includes(term)) hits++;
      if (hits >= 2) return true;
    }
    return false;
  });
}

function evaluateClaimEvidence(params: {
  claim: AcceptanceClaim;
  criterionAnalysis: AcceptanceAnalysis;
  evidence: EvidenceRecord;
  haystacks: string[];
}): ClaimEvidenceResult {
  const { claim, criterionAnalysis, evidence, haystacks } = params;
  if (claim.kind === 'internal_link') {
    return evaluateContractLinkClaims([claim], evidence) || 'unknown';
  }
  if (claim.kind === 'file_artifact') {
    return hasFileProof(claim.path, criterionAnalysis, evidence)
      ? 'pass'
      : 'unknown';
  }
  if (claim.kind === 'command') {
    if (hasCommandContradiction(claim.command, evidence)) return 'fail';
    return hasCommandProof(claim.command, evidence) ? 'pass' : 'unknown';
  }
  if (claim.kind === 'semantic_assertion') {
    return semanticAssertionHasProof(claim.text, haystacks)
      ? 'pass'
      : 'unknown';
  }
  if (claim.kind === 'unsupported_obligation') return 'unknown';

  const claimAnalysis = analysisFromClaims(
    criterionAnalysis.text,
    [claim],
  );
  const routeAnchor = claimAnalysis.anchors.find(
    (anchor): anchor is RouteAnchor => anchor.kind === 'route',
  );
  if (!routeAnchor) return 'unknown';
  if (
    hasRouteContradiction(
      claimAnalysis,
      routeAnchor.value,
      evidence,
      routeAnchor,
    )
  ) {
    return 'fail';
  }
  return hasRouteProof(
    claimAnalysis,
    routeAnchor.value,
    evidence,
    routeAnchor,
  )
    ? 'pass'
    : 'unknown';
}

export function matchAcceptanceAgainstEvidence(
  acceptance: string[],
  evidence: EvidenceRecord,
  persistedContract?: AcceptanceContract,
): {
  matched: string[];
  unmatched: string[];
  contradicted: string[];
  diagnostics: AcceptanceCriterionDiagnostic[];
} {
  const matched: string[] = [];
  const unmatched: string[] = [];
  const contradicted: string[] = [];
  const contract = resolveAcceptanceContract(acceptance, persistedContract);
  const haystackLower = genericEvidenceReceipts(evidence).map((entry) =>
    entry.toLowerCase(),
  );

  for (const contractCriterion of contract.criteria) {
    const criterion = contractCriterion.text;
    const analysis = analysisFromContract(contractCriterion);
    if (!analysis.executable) {
      unmatched.push(criterion);
      continue;
    }
    const claimResults = contractCriterion.all_of.map((claim) =>
      evaluateClaimEvidence({
        claim,
        criterionAnalysis: analysis,
        evidence,
        haystacks: haystackLower,
      }));
    if (claimResults.some((result) => result === 'fail')) {
      contradicted.push(criterion);
      continue;
    }
    if (
      claimResults.length > 0 &&
      claimResults.every((result) => result === 'pass')
    ) {
      matched.push(criterion);
      continue;
    }
    unmatched.push(criterion);
  }

  return {
    matched,
    unmatched,
    contradicted,
    diagnostics: buildAcceptanceDiagnostics({
      contract,
      evidence,
      matched,
      contradicted,
    }),
  };
}
