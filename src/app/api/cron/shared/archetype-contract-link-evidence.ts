import type {
  AcceptanceClaim,
} from '@/lib/services/requirement-acceptance-contract';
import type {
  EvidenceRecord,
} from '@/lib/services/requirement-ground-truth';
import {
  routeTemplateMatches,
} from '@/lib/services/acceptance-route-path';

type LinkClaim = Extract<AcceptanceClaim, { kind: 'internal_link' }>;
type LinkIntegrityResult = 'pass' | 'fail' | 'unknown' | null;

function regionMatches(
  claim: LinkClaim,
  region: string | undefined,
): boolean {
  if (!claim.region) return true;
  if (claim.region === 'navigation') {
    return region === 'navigation' || region === 'header';
  }
  return region === claim.region;
}

function linkPathMatches(expected: string, observed: string): boolean {
  return expected.trim().toLowerCase().replace(/\/+$/, '') ===
      observed.trim().toLowerCase().replace(/\/+$/, '') ||
    routeTemplateMatches(expected, observed);
}

export function evaluateContractLinkClaims(
  claims: AcceptanceClaim[],
  evidence: EvidenceRecord,
): LinkIntegrityResult {
  const linkClaims = claims.filter(
    (claim): claim is LinkClaim => claim.kind === 'internal_link',
  );
  if (linkClaims.length === 0) return null;
  const interaction = evidence.interaction;
  if (!interaction?.evaluable) return 'unknown';

  for (const claim of linkClaims) {
    const directCandidates = (interaction.links || []).filter(
      (link) =>
        regionMatches(claim, link.region) &&
        (!claim.path || linkPathMatches(claim.path, link.target)),
    );
    const unresolved = (interaction.unresolved_links || []).filter(
      (link) => regionMatches(claim, link.region),
    );
    if (
      claim.region &&
      directCandidates.length === 0 &&
      unresolved.length === 0
    ) {
      return 'unknown';
    }
    const sourceBindings = new Set(
      unresolved
        .map((link) => link.source_binding)
        .filter((binding): binding is string => !!binding),
    );
    const mappedCandidates = (interaction.links || []).filter(
      (link) =>
        link.region === 'other' &&
        !!link.source_binding &&
        sourceBindings.has(link.source_binding) &&
        (!claim.path || linkPathMatches(claim.path, link.target)),
    );
    const candidates = [...directCandidates, ...mappedCandidates];
    const targets = Array.from(
      new Set(candidates.map((link) => link.target)),
    );
    if (
      candidates.some((link) => !link.route_exists) ||
      (interaction.findings || []).some(
        (finding) =>
          finding.kind === 'broken_link' &&
          (
            !claim.path ||
            (
              !!finding.target &&
              linkPathMatches(claim.path, finding.target)
            )
          ),
      ) ||
      targets.some((target) =>
        (evidence.observations || []).some(
          (observation) =>
            !!observation.target &&
            linkPathMatches(target, observation.target) &&
            observation.disposition === 'hard_fail',
        ),
      )
    ) {
      return 'fail';
    }
    if (claim.path && candidates.length === 0) {
      return unresolved.length > 0 ? 'unknown' : 'fail';
    }
    if (!claim.path && candidates.length === 0) return 'unknown';
    if (
      unresolved.some(
        (link) =>
          !link.source_binding ||
          !mappedCandidates.some(
            (candidate) =>
              candidate.source_binding === link.source_binding,
          ),
      )
    ) {
      return 'unknown';
    }
    if (
      claim.requires_content &&
      !candidates.some((link) => !!link.content_excerpt?.trim())
    ) {
      return 'unknown';
    }
    if (!targets.every((target) =>
      (evidence.observations || []).some(
        (observation) =>
          !!observation.target &&
          linkPathMatches(target, observation.target) &&
          observation.disposition === 'pass',
      ),
    )) {
      return 'unknown';
    }
  }
  return 'pass';
}
