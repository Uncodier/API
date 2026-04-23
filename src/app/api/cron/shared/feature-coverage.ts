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
import { SandboxService } from '@/lib/services/sandbox-service';
import type { BacklogItem, BacklogItemKind } from '@/lib/services/requirement-backlog-types';
import { routesFromAcceptance, routesFromTouches } from '@/lib/services/requirement-acceptance';

export interface FeatureCoverageSignal {
  ok: boolean;
  declared_touches: string[];
  present_touches: string[];
  missing_touches: string[];
  expected_page_routes: string[];
  expected_api_routes: string[];
  present_page_files: string[];
  present_api_files: string[];
  /**
   * Acceptance anchors that reference a route (e.g. `/api/bookings returns 201`)
   * — used by the judge to cross-check that the item did ship the route it
   * promised, not just "a route".
   */
  acceptance_route_anchors: string[];
  kind_requirements: KindRequirementResult[];
}

export interface KindRequirementResult {
  kind: BacklogItemKind;
  requirement: string;
  satisfied: boolean;
  detail?: string;
}

async function existsInSandbox(sandbox: Sandbox, relPath: string): Promise<boolean> {
  const wd = SandboxService.WORK_DIR;
  try {
    const r = await sandbox.runCommand({
      cmd: 'sh',
      args: ['-c', `[ -e "${wd}/${relPath}" ] && echo __OK__ || echo __MISS__`],
    });
    const out = (await r.stdout()).toString();
    return out.trim() === '__OK__';
  } catch {
    return false;
  }
}

async function globCount(sandbox: Sandbox, pattern: string): Promise<number> {
  const wd = SandboxService.WORK_DIR;
  try {
    const r = await sandbox.runCommand({
      cmd: 'sh',
      args: ['-c', `cd "${wd}" && ls -1 ${pattern} 2>/dev/null | wc -l | awk '{print $1}'`],
    });
    const out = (await r.stdout()).toString();
    return Number(out.trim()) || 0;
  } catch {
    return 0;
  }
}

/**
 * For a page route like `/app/bookings`, check that either:
 *   - src/app/app/bookings/page.tsx exists, OR
 *   - src/app/app/bookings/page.jsx/ts/js exists (Next App Router).
 */
async function findPageFile(sandbox: Sandbox, route: string): Promise<string | null> {
  const clean = route.replace(/^\//, '').replace(/\/$/, '');
  const rel = clean ? `src/app/${clean}/page` : `src/app/page`;
  const exts = ['tsx', 'jsx', 'ts', 'js'];
  for (const ext of exts) {
    if (await existsInSandbox(sandbox, `${rel}.${ext}`)) return `${rel}.${ext}`;
  }
  return null;
}

async function findApiFile(sandbox: Sandbox, route: string): Promise<string | null> {
  const clean = route.replace(/^\/api\//, '').replace(/\/$/, '');
  if (!clean) return null;
  const rel = `src/app/api/${clean}/route`;
  const exts = ['ts', 'js'];
  for (const ext of exts) {
    if (await existsInSandbox(sandbox, `${rel}.${ext}`)) return `${rel}.${ext}`;
  }
  return null;
}

async function apiFileDeclaresHandlers(
  sandbox: Sandbox,
  relFile: string,
  handlers: string[],
): Promise<{ [k: string]: boolean }> {
  const wd = SandboxService.WORK_DIR;
  const out: Record<string, boolean> = Object.fromEntries(handlers.map((h) => [h, false]));
  try {
    const r = await sandbox.runCommand({
      cmd: 'sh',
      args: ['-c', `cat "${wd}/${relFile}" 2>/dev/null || true`],
    });
    const src = (await r.stdout()).toString();
    for (const h of handlers) {
      // Accept: `export async function GET` / `export const GET =` / `export { GET }`
      const re = new RegExp(`export\\s+(async\\s+)?function\\s+${h}\\b|export\\s+(const|let|var)\\s+${h}\\b|export\\s*\\{[^}]*\\b${h}\\b`);
      out[h] = re.test(src);
    }
  } catch {
    /* leave all false */
  }
  return out;
}

async function evaluateKindRequirements(
  sandbox: Sandbox,
  item: BacklogItem,
  presence: {
    presentPageFiles: string[];
    presentApiFiles: string[];
  },
): Promise<KindRequirementResult[]> {
  const out: KindRequirementResult[] = [];
  const tier = item.tier ?? 'core';
  if (tier !== 'core') return out;

  switch (item.kind) {
    case 'page': {
      out.push({
        kind: 'page',
        requirement: 'at_least_one_page_file',
        satisfied: presence.presentPageFiles.length > 0,
        detail: presence.presentPageFiles.join(', ') || 'no matching page.tsx found',
      });
      break;
    }
    case 'crud':
    case 'api': {
      const apis = presence.presentApiFiles;
      out.push({
        kind: item.kind,
        requirement: 'at_least_one_route_file',
        satisfied: apis.length > 0,
        detail: apis.join(', ') || 'no matching src/app/api/*/route.ts found',
      });
      if (apis.length > 0) {
        const handlers = item.kind === 'crud' ? ['GET', 'POST'] : ['GET'];
        const declared = await apiFileDeclaresHandlers(sandbox, apis[0], handlers);
        for (const h of handlers) {
          out.push({
            kind: item.kind,
            requirement: `exports_${h}`,
            satisfied: !!declared[h],
            detail: `${apis[0]}`,
          });
        }
      }
      break;
    }
    case 'auth': {
      const loginPresent = await findPageFile(sandbox, '/login');
      const authApiCount = await globCount(sandbox, 'src/app/api/auth/*/route.ts');
      out.push({
        kind: 'auth',
        requirement: 'login_page_or_auth_api',
        satisfied: !!loginPresent || authApiCount > 0,
        detail: loginPresent
          ? `page: ${loginPresent}`
          : authApiCount > 0
            ? `api: ${authApiCount} auth route handler(s)`
            : 'no /login page and no src/app/api/auth/**/route.ts',
      });
      break;
    }
    case 'integration': {
      // Heuristic: require at least one new server-side file touching lib/services/*
      // (platform SDK) or a route under /api that ships a server action. We cannot
      // run the integration here, so this is a structural check only; the Judge
      // still demands a curl/fetch tool-call in evidence.
      const integrationFiles = await globCount(sandbox, 'src/app/api/*/route.ts');
      const serviceFiles = await globCount(sandbox, 'src/lib/services/*.ts');
      out.push({
        kind: 'integration',
        requirement: 'server_side_artifact',
        satisfied: integrationFiles + serviceFiles > 0,
        detail: `api_routes=${integrationFiles} service_files=${serviceFiles}`,
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
}): Promise<FeatureCoverageSignal> {
  const { sandbox, item } = params;
  const acceptance = item.acceptance ?? [];
  const touches = item.touches ?? [];

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
  for (const route of expectedPageRoutes) {
    const found = await findPageFile(sandbox, route);
    if (found) presentPageFiles.push(found);
  }
  const presentApiFiles: string[] = [];
  for (const route of expectedApiRoutes) {
    const found = await findApiFile(sandbox, route);
    if (found) presentApiFiles.push(found);
  }

  const presentTouches: string[] = [];
  const missingTouches: string[] = [];
  for (const t of touches) {
    if (await existsInSandbox(sandbox, t)) presentTouches.push(t);
    else missingTouches.push(t);
  }

  const kindResults = await evaluateKindRequirements(sandbox, item, {
    presentPageFiles,
    presentApiFiles,
  });

  const kindOk = kindResults.every((r) => r.satisfied);
  const touchesOk = missingTouches.length === 0;
  const routesOk =
    expectedPageRoutes.length === presentPageFiles.length &&
    expectedApiRoutes.length === presentApiFiles.length;

  return {
    ok: kindOk && touchesOk && routesOk,
    declared_touches: touches,
    present_touches: presentTouches,
    missing_touches: missingTouches,
    expected_page_routes: expectedPageRoutes,
    expected_api_routes: expectedApiRoutes,
    present_page_files: presentPageFiles,
    present_api_files: presentApiFiles,
    acceptance_route_anchors: acceptanceRouteAnchors,
    kind_requirements: kindResults,
  };
}

export function summarizeFeatureCoverage(sig: FeatureCoverageSignal): string {
  const parts: string[] = [];
  if (sig.missing_touches.length) parts.push(`missing_touches=${sig.missing_touches.length}`);
  const missingPages = sig.expected_page_routes.length - sig.present_page_files.length;
  const missingApis = sig.expected_api_routes.length - sig.present_api_files.length;
  if (missingPages > 0) parts.push(`missing_pages=${missingPages}`);
  if (missingApis > 0) parts.push(`missing_apis=${missingApis}`);
  const failedKind = sig.kind_requirements.filter((r) => !r.satisfied);
  if (failedKind.length) parts.push(`kind_failures=${failedKind.map((r) => r.requirement).join(',')}`);
  return parts.length ? parts.join(' ') : 'coverage_ok';
}
