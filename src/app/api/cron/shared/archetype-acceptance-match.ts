import {
  validateAcceptance,
  type AcceptanceAnalysis,
} from '@/lib/services/requirement-acceptance';
import type { EvidenceRecord } from '@/lib/services/requirement-ground-truth';
import { evidenceHaystack } from './archetype-evidence';

function normalized(value: string): string {
  return value.toLowerCase().replace(/\/+$/, '');
}

function expectedHttpMethod(
  analysis: AcceptanceAnalysis,
): string | undefined {
  return analysis.anchors.find((anchor) => anchor.kind === 'http_verb')
    ?.value.toUpperCase();
}

function expectedStatus(
  analysis: AcceptanceAnalysis,
): string | undefined {
  return analysis.anchors.find((anchor) => anchor.kind === 'status_code')
    ?.value.toLowerCase();
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

function filePaths(evidence: EvidenceRecord): Set<string> {
  return new Set([
    ...(evidence.changed_files || []),
    ...(evidence.feature_coverage?.present_touches || []),
    ...(evidence.feature_coverage?.present_page_files || []),
    ...(evidence.feature_coverage?.present_api_files || []),
    ...(evidence.feature_coverage?.artifact_proofs || [])
      .filter(
        (proof) =>
          proof.exists &&
          proof.outcome !== 'not_evaluable' &&
          (proof.bytes ?? 1) > 0,
      )
      .map((proof) => proof.path),
  ].map((path) => normalized(path.replace(/^\.?\//, ''))));
}

function routeFileCandidates(route: string): string[] {
  const clean = normalized(route)
    .replace(/^\/+/, '')
    .split('/')
    .map((segment) =>
      segment.startsWith(':') && segment.length > 1
        ? `[${segment.slice(1)}]`
        : segment,
    )
    .join('/');
  if (!clean) return ['src/app/page.tsx', 'app/page.tsx'];
  if (clean.startsWith('api/')) {
    return [
      `src/app/${clean}/route.ts`,
      `src/app/${clean}/route.js`,
      `app/${clean}/route.ts`,
      `app/${clean}/route.js`,
    ];
  }
  return [
    `src/app/${clean}/page.tsx`,
    `src/app/${clean}/page.jsx`,
    `app/${clean}/page.tsx`,
    `app/${clean}/page.jsx`,
  ];
}

function significantRouteTerms(route: string): string[] {
  return route
    .toLowerCase()
    .split('/')
    .filter(
      (segment) =>
        segment.length >= 4 &&
        !segment.startsWith(':') &&
        !['api', 'dashboard'].includes(segment),
    )
    .flatMap((segment) => [
      segment,
      segment.endsWith('s') ? segment.slice(0, -1) : segment,
      segment.length >= 5 ? segment.replace(/(?:e|s)$/, '') : segment,
    ]);
}

function hasRelevantPassingTest(
  analysis: AcceptanceAnalysis,
  route: string,
  evidence: EvidenceRecord,
): boolean {
  const terms = significantRouteTerms(route);
  if (terms.length === 0) return false;
  const method = expectedHttpMethod(analysis)?.toLowerCase();
  const status = expectedStatus(analysis);
  return (evidence.tests || []).some((test) => {
    if (test.exit_code !== 0 || !test.ran_after_changes) return false;
    const receipt = `${test.command}\n${test.output_tail}`.toLowerCase();
    return (
      terms.some((term) => receipt.includes(term)) &&
      (!method || receipt.includes(method)) &&
      (!status || receipt.includes(status))
    );
  });
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
): boolean {
  const method = expectedHttpMethod(analysis);
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
): boolean {
  if (hasRouteContradiction(analysis, route, evidence)) return false;
  const method = expectedHttpMethod(analysis);
  const status = expectedStatus(analysis);
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
  const files = filePaths(evidence);
  const routeExists = routeFileCandidates(route).some((path) =>
    files.has(normalized(path)),
  );
  return routeExists && hasRelevantPassingTest(analysis, route, evidence);
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

function hasTypedProof(
  analysis: AcceptanceAnalysis,
  evidence: EvidenceRecord,
): boolean {
  const fileAnchors = analysis.anchors.filter(
    (anchor) => anchor.kind === 'file_path',
  );
  if (
    fileAnchors.length > 0 &&
    fileAnchors.every((anchor) =>
      hasFileProof(anchor.value, analysis, evidence),
    )
  ) {
    return true;
  }
  const routeAnchors = analysis.anchors.filter(
    (anchor) => anchor.kind === 'route',
  );
  return (
    routeAnchors.length > 0 &&
    routeAnchors.every((anchor) =>
      hasRouteProof(analysis, anchor.value, evidence),
    )
  );
}

function hasTypedContradiction(
  analysis: AcceptanceAnalysis,
  evidence: EvidenceRecord,
): boolean {
  return analysis.anchors
    .filter((anchor) => anchor.kind === 'route')
    .some((anchor) =>
      hasRouteContradiction(analysis, anchor.value, evidence),
    );
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
  const haystackLower = evidenceHaystack(evidence).map((entry) =>
    entry.toLowerCase(),
  );

  for (const criterion of acceptance) {
    const analysis = analysisByText.get(criterion);
    if (!analysis?.executable) {
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
        (anchor) => anchor.kind === 'route' || anchor.kind === 'file_path',
      )
    ) {
      unmatched.push(criterion);
      continue;
    }
    const anchors = analysis.anchors.map((anchor) =>
      anchor.value.toLowerCase(),
    );
    const minimumHits = Math.min(2, anchors.length);
    const matchedByReceipt = haystackLower.some((haystack) => {
      let hits = 0;
      for (const anchor of anchors) {
        if (haystack.includes(anchor)) hits++;
        if (hits >= minimumHits) return true;
      }
      return hits >= minimumHits;
    });
    if (matchedByReceipt) matched.push(criterion);
    else unmatched.push(criterion);
  }

  return { matched, unmatched, contradicted };
}
