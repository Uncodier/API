import {
  validateAcceptance,
  type AcceptanceAnchor,
  type AcceptanceAnalysis,
} from '@/lib/services/requirement-acceptance';
import type { EvidenceRecord } from '@/lib/services/requirement-ground-truth';
import {
  genericEvidenceReceipts,
  genericProofTerms,
} from './archetype-generic-evidence';
import { evaluateInternalLinkIntegrity } from './archetype-link-evidence';

type RouteAnchor = Extract<AcceptanceAnchor, { kind: 'route' }>;

function normalized(value: string): string {
  return value.toLowerCase().replace(/\/+$/, '');
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
  if (targetPath === expected) return true;
  const targetSegments = targetPath.split('/');
  const expectedSegments = expected.split('/');
  return (
    targetSegments.length === expectedSegments.length &&
    expectedSegments.every(
      (segment, index) =>
        segment.startsWith(':') || segment === targetSegments[index],
    )
  );
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
  return (evidence.tests || []).some((test) =>
    test.exit_code !== 0 &&
    (
      command === 'test' ||
      test.command.toLowerCase().replace(/\s+/g, ' ')
        .includes(expectedCommand)
    ),
  );
}

function hasTypedProof(
  analysis: AcceptanceAnalysis,
  evidence: EvidenceRecord,
): boolean {
  const proofGroups: boolean[] = [];
  const fileAnchors = analysis.anchors.filter(
    (anchor) => anchor.kind === 'file_path',
  );
  if (fileAnchors.length > 0) {
    proofGroups.push(fileAnchors.every((anchor) =>
      hasFileProof(anchor.value, analysis, evidence),
    ));
  }
  const routeAnchors = analysis.anchors.filter(
    (
      anchor,
    ): anchor is RouteAnchor =>
      anchor.kind === 'route',
  );
  if (routeAnchors.length > 0) {
    proofGroups.push(routeAnchors.every((anchor) =>
      hasRouteProof(analysis, anchor.value, evidence, anchor),
    ));
  }
  const commandAnchors = analysis.anchors.filter(
    (anchor) => anchor.kind === 'command',
  );
  if (commandAnchors.length > 0) {
    proofGroups.push(commandAnchors.every((anchor) =>
      hasCommandProof(anchor.value, evidence),
    ));
  }
  return proofGroups.length > 0 && proofGroups.every(Boolean);
}

function hasTypedContradiction(
  analysis: AcceptanceAnalysis,
  evidence: EvidenceRecord,
): boolean {
  return analysis.anchors.some((anchor) => {
    if (anchor.kind === 'route') {
      return hasRouteContradiction(
        analysis,
        anchor.value,
        evidence,
        anchor,
      );
    }
    if (anchor.kind === 'command') {
      return hasCommandContradiction(anchor.value, evidence);
    }
    return false;
  });
}

export function matchAcceptanceAgainstEvidence(
  acceptance: string[],
  evidence: EvidenceRecord,
): { matched: string[]; unmatched: string[]; contradicted: string[] } {
  const matched: string[] = [];
  const unmatched: string[] = [];
  const contradicted: string[] = [];
  const validation = validateAcceptance(acceptance);
  const analysisByText = new Map(
    validation.analyses.map((analysis) => [analysis.text, analysis]),
  );
  const haystackLower = genericEvidenceReceipts(evidence).map((entry) =>
    entry.toLowerCase(),
  );

  for (const criterion of acceptance) {
    const analysis = analysisByText.get(criterion);
    if (!analysis?.executable) {
      unmatched.push(criterion);
      continue;
    }
    const linkIntegrity = evaluateInternalLinkIntegrity(
      analysis,
      evidence,
      {
        proves: (route) => hasRouteProof(analysis, route, evidence),
        contradicts: (route) =>
          hasRouteContradiction(analysis, route, evidence),
      },
    );
    if (linkIntegrity === 'pass') {
      matched.push(criterion);
      continue;
    }
    if (linkIntegrity === 'fail') {
      contradicted.push(criterion);
      continue;
    }
    if (linkIntegrity === 'unknown') {
      unmatched.push(criterion);
      continue;
    }
    if (hasTypedContradiction(analysis, evidence)) {
      contradicted.push(criterion);
      continue;
    }
    if (hasTypedProof(analysis, evidence)) {
      matched.push(criterion);
      continue;
    }
    if (
      analysis.anchors.some(
        (anchor) =>
          anchor.kind === 'route' ||
          anchor.kind === 'file_path' ||
          anchor.kind === 'command',
      )
    ) {
      unmatched.push(criterion);
      continue;
    }
    const proofTerms = genericProofTerms(analysis);
    if (proofTerms.length < 2) {
      unmatched.push(criterion);
      continue;
    }
    const matchedByReceipt = haystackLower.some((haystack) => {
      let hits = 0;
      for (const term of proofTerms) {
        if (haystack.includes(term)) hits++;
        if (hits >= 2) return true;
      }
      return false;
    });
    if (matchedByReceipt) matched.push(criterion);
    else unmatched.push(criterion);
  }

  return { matched, unmatched, contradicted };
}
