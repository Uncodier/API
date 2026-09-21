/**
 * Feature coverage signal.
 *
 * Phase 10: the Judge is now allowed to reject a `core` item when the files
 * the item declared it would touch (or the routes its acceptance referenced)
 * simply do not exist in the sandbox after the producer claims done.
 *
 * Before Phase 10 the gate only validated whatever routes the git diff
 * produced — so an agent that only modified `src/app/page.tsx` would get a
 * 200 on `/` and the Judge would approve, even if the item was a `crud`
 * that required `src/app/api/<resource>/route.ts`.
 *
 * This module is read-only against the sandbox (stat-style checks) and
 * cheap — a handful of `test -f` invocations per call.
 */

import type { Sandbox } from '@vercel/sandbox';
import type { BacklogItem, BacklogItemKind } from '@/lib/services/requirement-backlog-types';
import {
  analyzeAcceptanceEntry,
  routesFromAcceptance,
  routesFromTouches,
} from '@/lib/services/requirement-acceptance';
import {
  apiFileDeclaresHandlers,
  findApiFile,
  findPageFile,
  globCount,
  normalizeTouchPath,
  readArtifactProof,
  type ArtifactProof,
  type CoverageProbeOutcome,
} from './feature-coverage-probes';

export interface FeatureCoverageSignal {
  ok: boolean;
  evaluable: boolean;
  declared_touches: string[];
  present_touches: string[];
  missing_touches: string[];
  not_evaluable_touches: string[];
  expected_page_routes: string[];
  expected_api_routes: string[];
  present_page_files: string[];
  present_api_files: string[];
  not_evaluable_page_routes: string[];
  not_evaluable_api_routes: string[];
  /**
   * Acceptance anchors that reference a route (e.g. `/api/bookings returns 201`)
   * — used by the judge to cross-check that the item did ship the route it
   * promised, not just "a route".
   */
  acceptance_route_anchors: string[];
  artifact_proofs: ArtifactProof[];
  kind_requirements: KindRequirementResult[];
  probe_errors: Array<{ target: string; detail: string }>;
}

export interface KindRequirementResult {
  kind: BacklogItemKind;
  requirement: string;
  satisfied: boolean;
  outcome: CoverageProbeOutcome;
  detail?: string;
}

async function evaluateKindRequirements(
  sandbox: Sandbox,
  item: BacklogItem,
  presence: {
    presentPageFiles: string[];
    presentApiFiles: string[];
    pageProbeUnknown: boolean;
    apiProbeUnknown: boolean;
    apiTargets: Array<{
      route: string;
      file: string;
      methods: string[];
    }>;
  },
): Promise<KindRequirementResult[]> {
  const out: KindRequirementResult[] = [];
  const tier = item.tier ?? 'core';
  if (tier !== 'core') return out;

  switch (item.kind) {
    case 'page': {
      const outcome: CoverageProbeOutcome =
        presence.presentPageFiles.length > 0
          ? 'pass'
          : presence.pageProbeUnknown
            ? 'not_evaluable'
            : 'fail';
      out.push({
        kind: 'page',
        requirement: 'at_least_one_page_file',
        satisfied: outcome === 'pass',
        outcome,
        detail: presence.presentPageFiles.join(', ') || 'no matching page.tsx found',
      });
      break;
    }
    case 'crud':
    case 'api': {
      const apis = presence.presentApiFiles;
      const routeOutcome: CoverageProbeOutcome =
        apis.length > 0
          ? 'pass'
          : presence.apiProbeUnknown
            ? 'not_evaluable'
            : 'fail';
      out.push({
        kind: item.kind,
        requirement: 'at_least_one_route_file',
        satisfied: routeOutcome === 'pass',
        outcome: routeOutcome,
        detail: apis.join(', ') || 'no matching src/app/api/*/route.ts found',
      });
      for (const target of presence.apiTargets) {
        const handlers = target.methods.length > 0
          ? target.methods
          : item.kind === 'crud'
            ? ['GET', 'POST']
            : [];
        const declared = await apiFileDeclaresHandlers(
          sandbox,
          target.file,
          handlers,
        );
        for (const handler of handlers) {
          const outcome: CoverageProbeOutcome =
            declared.outcome === 'not_evaluable'
              ? 'not_evaluable'
              : declared.handlers[handler]
                ? 'pass'
                : 'fail';
          out.push({
            kind: item.kind,
            requirement: `${handler} ${target.route} exports_${handler}`,
            satisfied: outcome === 'pass',
            outcome,
            detail: declared.detail || target.file,
          });
        }
      }
      break;
    }
    case 'auth': {
      const login = await findPageFile(sandbox, '/login');
      const authApis = await globCount(
        sandbox,
        'src/app/api/auth/*/route.ts',
      );
      const outcome: CoverageProbeOutcome =
        !!login.file || authApis.count > 0
          ? 'pass'
          : login.outcome === 'not_evaluable' ||
              authApis.outcome === 'not_evaluable'
            ? 'not_evaluable'
            : 'fail';
      out.push({
        kind: 'auth',
        requirement: 'login_page_or_auth_api',
        satisfied: outcome === 'pass',
        outcome,
        detail: login.file
          ? `page: ${login.file}`
          : authApis.count > 0
            ? `api: ${authApis.count} auth route handler(s)`
            : login.detail || authApis.detail ||
              'no /login page and no src/app/api/auth/**/route.ts',
      });
      break;
    }
    case 'integration': {
      // Heuristic: require at least one new server-side file touching lib/services/*
      // (platform SDK) or a route under /api that ships a server action. We cannot
      // run the integration here, so this is a structural check only; the Judge
      // still demands a curl/fetch tool-call in evidence.
      const integrationFiles = await globCount(
        sandbox,
        'src/app/api/*/route.ts',
      );
      const serviceFiles = await globCount(
        sandbox,
        'src/lib/services/*.ts',
      );
      const outcome: CoverageProbeOutcome =
        integrationFiles.count + serviceFiles.count > 0
          ? 'pass'
          : integrationFiles.outcome === 'not_evaluable' ||
              serviceFiles.outcome === 'not_evaluable'
            ? 'not_evaluable'
            : 'fail';
      out.push({
        kind: 'integration',
        requirement: 'server_side_artifact',
        satisfied: outcome === 'pass',
        outcome,
        detail:
          integrationFiles.detail ||
          serviceFiles.detail ||
          `api_routes=${integrationFiles.count} service_files=${serviceFiles.count}`,
      });
      break;
    }
    default:
      break;
  }
  return out;
}

export async function computeFeatureCoverage(params: {
  sandbox: Sandbox;
  item: BacklogItem;
  contractScoped?: boolean;
}): Promise<FeatureCoverageSignal> {
  const { sandbox, item, contractScoped = false } = params;
  const acceptance = item.acceptance ?? [];
  const acceptanceAnalyses = acceptance.map(analyzeAcceptanceEntry);
  const acceptanceFileAnchors = acceptanceAnalyses.flatMap((analysis) =>
    analysis.anchors
      .filter((anchor) => anchor.kind === 'file_path')
      .map((anchor) => anchor.value),
  );
  const touches = contractScoped
    ? Array.from(new Set(acceptanceFileAnchors))
    : item.touches ?? [];

  const acceptanceRouteAnchors = routesFromAcceptance(acceptance);
  const { pages: pagesFromTouches, apis: apisFromTouches } = routesFromTouches(touches);

  const expectedPageRoutes = Array.from(new Set([
    ...pagesFromTouches,
    ...acceptanceRouteAnchors.filter((r) => !r.startsWith('/api/')),
  ]));
  const expectedApiRoutes = Array.from(new Set([
    ...apisFromTouches,
    ...acceptanceRouteAnchors.filter((r) => r.startsWith('/api/')),
  ]));

  const presentPageFiles: string[] = [];
  const notEvaluablePageRoutes: string[] = [];
  const probeErrors: Array<{ target: string; detail: string }> = [];
  for (const route of expectedPageRoutes) {
    const result = await findPageFile(sandbox, route);
    if (result.file) presentPageFiles.push(result.file);
    if (result.outcome === 'not_evaluable') {
      notEvaluablePageRoutes.push(route);
      probeErrors.push({
        target: route,
        detail: result.detail || 'Page-file probe failed.',
      });
    }
  }
  const presentApiFiles: string[] = [];
  const notEvaluableApiRoutes: string[] = [];
  const apiTargets: Array<{
    route: string;
    file: string;
    methods: string[];
  }> = [];
  for (const route of expectedApiRoutes) {
    const result = await findApiFile(sandbox, route);
    if (result.outcome === 'not_evaluable') {
      notEvaluableApiRoutes.push(route);
      probeErrors.push({
        target: route,
        detail: result.detail || 'API-file probe failed.',
      });
    }
    if (!result.file) continue;
    presentApiFiles.push(result.file);
    const methods = Array.from(new Set(
      acceptanceAnalyses.flatMap((analysis) =>
        analysis.anchors
          .filter(
            (anchor) =>
              anchor.kind === 'route' &&
              anchor.value === route &&
              !!anchor.method,
          )
          .map((anchor) => anchor.method!.toUpperCase()),
      ),
    ));
    apiTargets.push({ route, file: result.file, methods });
  }

  const presentTouches: string[] = [];
  const missingTouches: string[] = [];
  const notEvaluableTouches: string[] = [];
  const artifactProofs: FeatureCoverageSignal['artifact_proofs'] = [];
  for (const t of touches) {
    const proof = await readArtifactProof(sandbox, t);
    artifactProofs.push(proof);
    if (proof.outcome === 'pass') {
      presentTouches.push(proof.path);
    } else if (proof.outcome === 'not_evaluable') {
      notEvaluableTouches.push(proof.path);
      probeErrors.push({
        target: proof.path,
        detail: proof.error || 'Artifact probe failed.',
      });
    } else {
      missingTouches.push(normalizeTouchPath(t));
    }
  }

  const kindResults = contractScoped
    ? []
    : await evaluateKindRequirements(sandbox, item, {
        presentPageFiles,
        presentApiFiles,
        pageProbeUnknown: notEvaluablePageRoutes.length > 0,
        apiProbeUnknown: notEvaluableApiRoutes.length > 0,
        apiTargets,
      });
  for (const requirement of kindResults) {
    if (requirement.outcome !== 'not_evaluable') continue;
    probeErrors.push({
      target: requirement.requirement,
      detail: requirement.detail || 'Kind requirement probe failed.',
    });
  }

  const kindOk = kindResults.every((r) => r.satisfied);
  const touchesOk = missingTouches.length === 0;
  const routesOk =
    expectedPageRoutes.length === presentPageFiles.length &&
    expectedApiRoutes.length === presentApiFiles.length;
  const evaluable =
    notEvaluableTouches.length === 0 &&
    notEvaluablePageRoutes.length === 0 &&
    notEvaluableApiRoutes.length === 0 &&
    kindResults.every((result) => result.outcome !== 'not_evaluable');

  return {
    ok: evaluable && kindOk && touchesOk && routesOk,
    evaluable,
    declared_touches: touches,
    present_touches: presentTouches,
    missing_touches: missingTouches,
    not_evaluable_touches: notEvaluableTouches,
    expected_page_routes: expectedPageRoutes,
    expected_api_routes: expectedApiRoutes,
    present_page_files: presentPageFiles,
    present_api_files: presentApiFiles,
    not_evaluable_page_routes: notEvaluablePageRoutes,
    not_evaluable_api_routes: notEvaluableApiRoutes,
    acceptance_route_anchors: acceptanceRouteAnchors,
    artifact_proofs: artifactProofs,
    kind_requirements: kindResults,
    probe_errors: probeErrors,
  };
}

export function summarizeFeatureCoverage(sig: FeatureCoverageSignal): string {
  const parts: string[] = [];
  if (!sig.evaluable) {
    parts.push(`probe_errors=${sig.probe_errors.length}`);
  }
  if (sig.missing_touches.length) parts.push(`missing_touches=${sig.missing_touches.length}`);
  const missingPages =
    sig.expected_page_routes.length -
    sig.present_page_files.length -
    sig.not_evaluable_page_routes.length;
  const missingApis =
    sig.expected_api_routes.length -
    sig.present_api_files.length -
    sig.not_evaluable_api_routes.length;
  if (missingPages > 0) parts.push(`missing_pages=${missingPages}`);
  if (missingApis > 0) parts.push(`missing_apis=${missingApis}`);
  const failedKind = sig.kind_requirements.filter(
    (result) =>
      !result.satisfied && result.outcome !== 'not_evaluable',
  );
  if (failedKind.length) parts.push(`kind_failures=${failedKind.map((r) => r.requirement).join(',')}`);
  return parts.length ? parts.join(' ') : 'coverage_ok';
}
