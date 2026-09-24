import {
  analyzeAcceptanceEntry,
  type AcceptanceAnalysis,
} from './requirement-acceptance';
import {
  analyzeProbeRoutePath,
} from './acceptance-route-path';
import {
  analyzeAcceptanceArtifactPath,
} from './acceptance-artifact-path';
import { z } from 'zod';

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

export interface AcceptanceDiscoverySpec {
  query: string;
  hypothetical_code?: string;
  expected_symbols?: string[];
}

export interface AcceptanceCriterionContractV2 {
  id: string;
  text: string;
  all_of: AcceptanceClaim[];
  /**
   * Optional semantic retrieval input. Retrieval may locate candidates, but
   * only deterministic source inspection may turn one into a probe target.
   */
  discovery?: AcceptanceDiscoverySpec;
}

export interface AcceptanceContractV2 {
  schema_version: 2;
  source: 'declared';
  criteria: AcceptanceCriterionContractV2[];
}

export type AcceptanceContract =
  | AcceptanceContractV1
  | AcceptanceContractV2;

const HttpMethodSchema = z.enum([
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
]);

const NonEmptyTextSchema = z.string().trim().min(1);
const RoutePathSchema = NonEmptyTextSchema
  .superRefine((value, context) => {
    const route = analyzeProbeRoutePath(value);
    if (!route.valid) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: route.reason || 'Invalid route path.',
      });
    }
  })
  .transform((value) => analyzeProbeRoutePath(value).normalized || value);
const ArtifactPathSchema = NonEmptyTextSchema
  .superRefine((value, context) => {
    const artifact = analyzeAcceptanceArtifactPath(value);
    if (!artifact.valid) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: artifact.reason || 'Invalid artifact path.',
      });
    }
  })
  .transform((value) =>
    analyzeAcceptanceArtifactPath(value).normalized || value);
const ExpectedStatusSchema = z.string().trim()
  .regex(/^(?:[1-5]\d\d|[1-5]xx)$/i)
  .transform((value) => value.toLowerCase())
  .optional();

const AcceptanceClaimSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('http_response'),
    path: RoutePathSchema,
    method: HttpMethodSchema,
    expected_status: ExpectedStatusSchema,
    auth: z.enum(['required', 'unspecified']),
  }),
  z.object({
    kind: z.literal('page_response'),
    path: RoutePathSchema,
    expected_status: ExpectedStatusSchema,
  }),
  z.object({
    kind: z.literal('internal_link'),
    path: RoutePathSchema.optional(),
    region: z.enum([
      'header',
      'footer',
      'navigation',
      'other',
    ]).optional(),
    requires_content: z.boolean(),
  }),
  z.object({
    kind: z.literal('file_artifact'),
    path: ArtifactPathSchema,
  }),
  z.object({
    kind: z.literal('command'),
    command: NonEmptyTextSchema,
  }),
  z.object({
    kind: z.literal('semantic_assertion'),
    text: NonEmptyTextSchema,
  }),
  z.object({
    kind: z.literal('unsupported_obligation'),
    text: NonEmptyTextSchema,
    reason: z.enum(['narrative', 'compound']),
  }),
]);

const DeclaredAcceptanceContractSchema = z.object({
  schema_version: z.literal(2),
  source: z.literal('declared'),
  criteria: z.array(z.object({
    id: NonEmptyTextSchema,
    text: NonEmptyTextSchema,
    all_of: z.array(AcceptanceClaimSchema).min(1),
    discovery: z.object({
      query: NonEmptyTextSchema,
      hypothetical_code: NonEmptyTextSchema.optional(),
      expected_symbols: z.array(NonEmptyTextSchema).optional(),
    }).optional(),
  })).min(1),
});

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
      if (
        anchor.value.startsWith('/api/') ||
        (
          anchor.method !== undefined &&
          anchor.method.toUpperCase() !== 'GET'
        )
      ) {
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

function contractMatchesAcceptance(
  acceptance: string[],
  contract: AcceptanceContract | undefined,
): contract is AcceptanceContract {
  if (!contract || !Array.isArray(contract.criteria)) return false;
  const persistedTexts = contract?.criteria.map(
    (criterion) => criterion.text,
  );
  return (
    (contract?.schema_version === 1 || contract?.schema_version === 2) &&
    persistedTexts?.length === acceptance.length &&
    persistedTexts.every((text, index) => text === acceptance[index])
  );
}

export function parseDeclaredAcceptanceContract(
  acceptance: string[],
  value: unknown,
): AcceptanceContractV2 {
  const parsed = DeclaredAcceptanceContractSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `Invalid declared acceptance contract: ${issue?.message || 'schema mismatch'}`,
    );
  }
  if (!contractMatchesAcceptance(
    acceptance,
    parsed.data as AcceptanceContractV2,
  )) {
    throw new Error(
      'Invalid declared acceptance contract: criteria must match acceptance[] in the same order.',
    );
  }
  const ids = parsed.data.criteria.map((criterion) => criterion.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error(
      'Invalid declared acceptance contract: criterion ids must be unique.',
    );
  }
  const missingDiscovery = parsed.data.criteria.find((criterion) => {
    const semanticOnly = criterion.all_of.every(
      (claim) => claim.kind === 'semantic_assertion',
    );
    return semanticOnly && !criterion.discovery?.hypothetical_code;
  });
  if (missingDiscovery) {
    throw new Error(
      `Invalid declared acceptance contract: semantic-only criterion "${missingDiscovery.id}" requires discovery.hypothetical_code.`,
    );
  }
  return parsed.data as AcceptanceContractV2;
}

export function isDeclaredAcceptanceContract(
  contract: AcceptanceContract | undefined,
): contract is AcceptanceContractV2 {
  return contract?.schema_version === 2 && contract.source === 'declared';
}

export function acceptanceContractIsExecutable(
  contract: AcceptanceContract,
): boolean {
  return (
    contract.criteria.length > 0 &&
    contract.criteria.every(
      (criterion) =>
        criterion.all_of.length > 0 &&
        criterion.all_of.every(
          (claim) => claim.kind !== 'unsupported_obligation',
        ),
    )
  );
}

export function validateAcceptanceContract(
  contract: AcceptanceContract,
): {
  has_any_executable: boolean;
  unsupported: string[];
} {
  const unsupported = contract.criteria
    .filter(
      (criterion) =>
        criterion.all_of.length === 0 ||
        criterion.all_of.some(
          (claim) => claim.kind === 'unsupported_obligation',
        ),
    )
    .map((criterion) => criterion.text);
  return {
    has_any_executable:
      contract.criteria.length > unsupported.length,
    unsupported,
  };
}

export function normalizeAcceptanceContractForPersistence(
  acceptance: string[],
  persisted?: AcceptanceContract,
): AcceptanceContract {
  if (persisted?.schema_version === 2) {
    return parseDeclaredAcceptanceContract(acceptance, persisted);
  }
  return persisted
    ? resolveAcceptanceContract(acceptance, persisted)
    : compileAcceptanceContract(acceptance);
}

export function resolveAcceptanceContract(
  acceptance: string[],
  persisted?: AcceptanceContract,
): AcceptanceContract {
  if (contractMatchesAcceptance(acceptance, persisted)) {
    if (persisted.schema_version === 2) {
      try {
        return parseDeclaredAcceptanceContract(acceptance, persisted);
      } catch {
        return {
          schema_version: 1,
          criteria: acceptance.map((text, index) => ({
            id: `criterion-${index + 1}`,
            text,
            all_of: [{
              kind: 'unsupported_obligation',
              text,
              reason: 'narrative',
            }],
          })),
        };
      }
    }
    return persisted;
  }
  return compileAcceptanceContract(acceptance);
}
