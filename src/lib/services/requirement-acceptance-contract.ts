import {
  analyzeAcceptanceEntry,
  type AcceptanceAnalysis,
} from './requirement-acceptance';

export type AcceptanceHttpMethod =
  | 'GET'
  | 'POST'
  | 'PUT'
  | 'DELETE'
  | 'PATCH';

export type AcceptanceLinkRegion =
  | 'header'
  | 'footer'
  | 'navigation'
  | 'other';

export type AcceptanceClaim =
  | {
      kind: 'http_response';
      path: string;
      method: AcceptanceHttpMethod;
      expected_status?: string;
      auth: 'required' | 'unspecified';
    }
  | {
      kind: 'page_response';
      path: string;
      expected_status?: string;
    }
  | {
      kind: 'internal_link';
      path?: string;
      region?: AcceptanceLinkRegion;
      requires_content: boolean;
    }
  | {
      kind: 'file_artifact';
      path: string;
    }
  | {
      kind: 'command';
      command: string;
    }
  | {
      kind: 'semantic_assertion';
      text: string;
    }
  | {
      kind: 'unsupported_obligation';
      text: string;
      reason: 'narrative' | 'compound';
    };

export interface AcceptanceCriterionContractV1 {
  id: string;
  text: string;
  all_of: AcceptanceClaim[];
}

export interface AcceptanceContractV1 {
  schema_version: 1;
  criteria: AcceptanceCriterionContractV1[];
}

const LINK_LANGUAGE_RE =
  /\b(?:links?|enlaces?|href|navigates?\s+to|navega\s+(?:a|hacia)|wraps?)\b/i;
const LINK_RELATION_RE =
  /\b(?:links?|enlaces?|href|navigates?|navega|wraps?|envuelve|contains?|contiene)\b/i;
const CONTENT_SUBJECT_RE =
  /\b(?:icons?|iconos?|text|texto|copy|content|contenido|logos?|titles?|t[ií]tulos?|images?|im[aá]genes?)\b/i;
const CONTENT_PREDICATE_RE =
  /\b(?:renders?|shows?|displays?|uses?|has|have|is|are|aparece|muestra|renderiza|usa|tiene)\b/i;
const VISUAL_STYLE_RE =
  /\b(?:styles?|styling|estilos?|colors?|colores?|spacing|typography|tipograf[ií]a)\b/i;

function linkRegion(text: string): AcceptanceLinkRegion | undefined {
  if (/\b(?:footer|pie de p[aá]gina)\b/i.test(text)) return 'footer';
  if (/\b(?:header|cabecera)\b/i.test(text)) return 'header';
  if (/\b(?:navigation|navbar|navegaci[oó]n|men[uú])\b/i.test(text)) {
    return 'navigation';
  }
  return undefined;
}

function isLinkCriterion(text: string, routes: string[]): boolean {
  return LINK_LANGUAGE_RE.test(text) && (
    routes.some((route) => !route.startsWith('/api/')) ||
    linkRegion(text) !== undefined ||
    /\b(?:internal|internos?)\b/i.test(text)
  );
}

function authExpectation(text: string): 'required' | 'unspecified' {
  return /\b(?:requires?\s+auth(?:entication)?|authenticated|authorized|signed[- ]in|protected\s+(?:api|endpoint|route)|current\s+user|created\s+by\s+the\s+user|their\s+organization)\b/i.test(
    text,
  )
    ? 'required'
    : 'unspecified';
}

function unsupportedCompoundSegments(text: string): string[] {
  return text
    .split(/\s*(?:,|;|\band\b|\by\b)\s*/i)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .filter((segment) => {
      if (LINK_RELATION_RE.test(segment)) return false;
      if (VISUAL_STYLE_RE.test(segment)) return true;
      return CONTENT_SUBJECT_RE.test(segment) && CONTENT_PREDICATE_RE.test(segment);
    });
}

export function hasIndependentCompoundObligation(text: string): boolean {
  return unsupportedCompoundSegments(text).length > 0;
}

function claimsForAnalysis(analysis: AcceptanceAnalysis): AcceptanceClaim[] {
  if (!analysis.executable) {
    return [{
      kind: 'unsupported_obligation',
      text: analysis.text,
      reason: 'narrative',
    }];
  }

  const claims: AcceptanceClaim[] = [];
  const routeAnchors = analysis.anchors.filter(
    (anchor) => anchor.kind === 'route',
  );
  const linkCriterion = isLinkCriterion(
    analysis.text,
    routeAnchors.map((anchor) => anchor.value),
  );

  if (linkCriterion) {
    const pageRoutes = routeAnchors
      .map((anchor) => anchor.value)
      .filter((route) => !route.startsWith('/api/'));
    if (pageRoutes.length > 0) {
      for (const path of pageRoutes) {
        claims.push({
          kind: 'internal_link',
          path,
          region: linkRegion(analysis.text),
          requires_content: CONTENT_SUBJECT_RE.test(analysis.text),
        });
      }
    } else {
      claims.push({
        kind: 'internal_link',
        region: linkRegion(analysis.text),
        requires_content: CONTENT_SUBJECT_RE.test(analysis.text),
      });
    }
    for (const segment of unsupportedCompoundSegments(analysis.text)) {
      claims.push({
        kind: 'unsupported_obligation',
        text: segment,
        reason: 'compound',
      });
    }
  } else {
    for (const anchor of routeAnchors) {
      if (anchor.value.startsWith('/api/')) {
        claims.push({
          kind: 'http_response',
          path: anchor.value,
          method: (anchor.method || 'GET') as AcceptanceHttpMethod,
          expected_status: anchor.status,
          auth: authExpectation(analysis.text),
        });
      } else {
        claims.push({
          kind: 'page_response',
          path: anchor.value,
          expected_status: anchor.status,
        });
      }
    }
  }

  for (const anchor of analysis.anchors) {
    if (anchor.kind === 'file_path') {
      claims.push({ kind: 'file_artifact', path: anchor.value });
    }
    if (anchor.kind === 'command') {
      claims.push({ kind: 'command', command: anchor.value });
    }
  }

  if (claims.length === 0) {
    claims.push({ kind: 'semantic_assertion', text: analysis.text });
  }
  return claims;
}

export function compileAcceptanceContract(
  acceptance: string[] | undefined | null,
): AcceptanceContractV1 {
  return {
    schema_version: 1,
    criteria: (acceptance || []).map((text, index) => ({
      id: `criterion-${index + 1}`,
      text,
      all_of: claimsForAnalysis(analyzeAcceptanceEntry(text)),
    })),
  };
}

export function resolveAcceptanceContract(
  acceptance: string[],
  persisted?: AcceptanceContractV1,
): AcceptanceContractV1 {
  const persistedTexts = persisted?.criteria.map((criterion) => criterion.text);
  if (
    persisted?.schema_version === 1 &&
    persistedTexts?.length === acceptance.length &&
    persistedTexts.every((text, index) => text === acceptance[index])
  ) {
    return persisted;
  }
  return compileAcceptanceContract(acceptance);
}
