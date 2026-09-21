import type { AcceptanceAnalysis } from '@/lib/services/requirement-acceptance';
import type { EvidenceRecord } from '@/lib/services/requirement-ground-truth';

export type LinkIntegrityResult = 'pass' | 'fail' | 'unknown' | null;

function isInternalLinkIntegrityCriterion(text: string): boolean {
  const normalizedText = text.toLowerCase();
  const namesLinkRegion =
    /\b(?:navigation|navbar|header|footer|navegaci[oó]n|men[uú]|cabecera|pie de p[aá]gina)\b/.test(
      normalizedText,
    );
  return (
    /(?:broken|dead|invalid)\s+(?:internal\s+)?links?/.test(normalizedText) ||
    /internal\s+links?.*(?:work|resolve|valid)/.test(normalizedText) ||
    /(?:enlaces?|links?)\s+(?:internos?\s+)?(?:rotos?|inv[aá]lidos?)/.test(
      normalizedText,
    ) ||
    (
      namesLinkRegion &&
      /\b(?:enlaces?|links?)\b/.test(normalizedText) &&
      (
        /\b(?:resolve|work|valid|funcionan|resuelven)\b/.test(normalizedText) ||
        /\b(?:to|towards?|hacia)\b/.test(normalizedText)
      )
    )
  );
}

function hasUnsupportedCompoundObligation(text: string): boolean {
  return /\b(?:icons?|iconos?|styles?|styling|estilos?|text|texto|copy|content|contenido|logos?|colors?|colores?|spacing|typography|tipograf[ií]a|images?|im[aá]genes?)\b/i.test(
    text,
  );
}

export function evaluateInternalLinkIntegrity(
  analysis: AcceptanceAnalysis,
  evidence: EvidenceRecord,
  routeEvidence: {
    proves: (route: string) => boolean;
    contradicts: (route: string) => boolean;
  },
): LinkIntegrityResult {
  if (!isInternalLinkIntegrityCriterion(analysis.text)) return null;
  const interaction = evidence.interaction;
  if (!interaction?.evaluable) return 'unknown';

  const criterion = analysis.text.toLowerCase();
  const requiresNavigation =
    /\b(?:navigation|navbar|header|navegaci[oó]n|men[uú]|cabecera)\b/.test(
      criterion,
    );
  const requiresFooter = /\b(?:footer|pie de p[aá]gina)\b/.test(criterion);
  const allLinks = interaction.links || [];
  const unresolvedLinks = interaction.unresolved_links || [];
  const scopedLinks = allLinks.filter((link) => {
    if (requiresFooter && link.region === 'footer') return true;
    if (
      requiresNavigation &&
      (link.region === 'header' || link.region === 'navigation')
    ) {
      return true;
    }
    return !requiresFooter && !requiresNavigation;
  });
  const scopedUnresolved = unresolvedLinks.filter((link) => {
    if (requiresFooter && link.region === 'footer') return true;
    if (
      requiresNavigation &&
      (link.region === 'header' || link.region === 'navigation')
    ) {
      return true;
    }
    return !requiresFooter && !requiresNavigation;
  });
  const scopedBindings = new Set(
    scopedUnresolved
      .map((link) => link.source_binding)
      .filter((binding): binding is string => !!binding),
  );
  const candidateLinks = [
    ...scopedLinks,
    ...allLinks.filter(
      (link) =>
        link.region === 'other' &&
        !!link.source_binding &&
        scopedBindings.has(link.source_binding),
    ),
  ];
  const allLinkOccurrences = [...allLinks, ...unresolvedLinks];
  if (
    requiresNavigation &&
    !allLinkOccurrences.some(
      (link) =>
        link.region === 'header' || link.region === 'navigation',
    )
  ) {
    return 'unknown';
  }
  if (
    requiresFooter &&
    !allLinkOccurrences.some((link) => link.region === 'footer')
  ) {
    return 'unknown';
  }
  if (!requiresFooter && !requiresNavigation && scopedLinks.length === 0) {
    return 'unknown';
  }

  const anchoredTargets = analysis.anchors
    .filter((anchor) => anchor.kind === 'route')
    .map((anchor) => anchor.value);
  const expectedTargets = Array.from(new Set(
    anchoredTargets.filter((target) => !target.startsWith('/api/')),
  ));
  const targets = expectedTargets.length > 0
    ? expectedTargets
    : Array.from(new Set(candidateLinks.map((link) => link.target)));
  if (targets.length === 0) return 'unknown';

  const collectedTargets = new Set(
    candidateLinks.map((link) => link.target),
  );
  if (expectedTargets.length > 0) {
    const hasMissingTarget = expectedTargets.some(
      (target) => !collectedTargets.has(target),
    );
    if (hasMissingTarget) {
      return scopedUnresolved.length > 0 ? 'unknown' : 'fail';
    }
  }
  if (
    expectedTargets.length === 0 &&
    scopedUnresolved.some((link) => {
      const isInRequiredRegion =
        (requiresFooter && link.region === 'footer') ||
        (
        requiresNavigation &&
        (link.region === 'header' || link.region === 'navigation')
        ) ||
        (!requiresFooter && !requiresNavigation);
      if (!isInRequiredRegion) return false;
      return !link.source_binding || !candidateLinks.some(
        (candidate) =>
          candidate.source_binding === link.source_binding,
      );
    })
  ) {
    return 'unknown';
  }

  const targetLinks = candidateLinks.filter((link) =>
    targets.includes(link.target),
  );
  if (
    targetLinks.some((link) => !link.route_exists) ||
    (interaction.findings || []).some(
      (finding) =>
        finding.kind === 'broken_link' &&
        !!finding.target &&
        targets.includes(finding.target),
    ) ||
    targets.some(routeEvidence.contradicts)
  ) {
    return 'fail';
  }
  if (!targets.every(routeEvidence.proves)) return 'unknown';
  // Link evidence proves only link integrity. A criterion that also requires
  // visual/content deliverables must remain unmatched until those obligations
  // have their own evidence instead of inheriting the link verdict.
  return hasUnsupportedCompoundObligation(analysis.text) ? 'unknown' : 'pass';
}
