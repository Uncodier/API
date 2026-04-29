/**
 * Runtime + visual probes orchestrator used by runBuildAndOriginGate.
 *
 * Keeps the probe flow off the big gate file:
 *   1) infer target routes from git diff
 *   2) start next start inside the sandbox, hit pages + APIs
 *   3) if we're in an apps repo with real pages, keep the server alive and
 *      run the visual probe (puppeteer on the host → sandbox.domain(port))
 *   4) stop the server either way
 *
 * Produces a `GateSignals` slice the gate plugs into its return value.
 */

import type { Sandbox } from '@vercel/sandbox';
import {
  CronInfraEvent,
  logCronInfrastructureEvent,
  type CronAuditContext,
} from '@/lib/services/cron-audit-log';
import {
  runRuntimeProbe,
  stopProbeServer,
  summarizeRuntimeProbe,
} from './step-runtime-probe';
import { inferTargetRoutesFromDiff } from './step-runtime-targets';
import { runVisualProbe } from './step-visual-probe';
import { runE2eScenarios } from './step-e2e-runner';
import {
  mergeCriticIntoVisualSignal,
  runVisualCritic,
  verdictBlocksGate,
} from './step-visual-critic';
import {
  buildApiSignalFromProbe,
  buildRuntimeSignalFromProbe,
  type ApiSignal,
  type ConsoleSignal,
  type RuntimeSignal,
  type ScenarioSignal,
  type VisualSignal,
} from './step-iteration-signals';
import { detectCopyHygieneIssues, summarizeCopyHygiene } from './step-copy-hygiene';
import type { GitRepoKind } from './cron-commit-helpers';
import type { Browser } from 'puppeteer-core';
import { launchPuppeteerForGate } from '@/lib/puppeteer/launch-gate-browser';

export type ProbeSignals = {
  runtime?: RuntimeSignal;
  api?: ApiSignal;
  console?: ConsoleSignal;
  visual?: VisualSignal;
  scenarios?: ScenarioSignal;
};

export async function runRuntimeAndVisualProbes(params: {
  sandbox: Sandbox;
  stepOrder: number;
  requirementId: string;
  gitRepoKind: GitRepoKind;
  audit?: CronAuditContext;
  shouldRunVisual?: boolean;
  stepContext?: {
    title?: string;
    instructions?: string;
    expected_output?: string;
    brand_context?: string;
  };
}): Promise<{
  ok: boolean;
  error?: string;
  signals: ProbeSignals;
}> {
  const { sandbox, stepOrder, requirementId, gitRepoKind, audit, stepContext } = params;
  const out: ProbeSignals = {};

  let inferred: Awaited<ReturnType<typeof inferTargetRoutesFromDiff>>;
  try {
    inferred = await inferTargetRoutesFromDiff(sandbox);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn('[GateProbes] inferTargetRoutesFromDiff threw:', msg);
    inferred = { pageRoutes: [], apiRoutes: [], changedFiles: [] };
  }

  const stepText = `${stepContext?.title || ''} ${stepContext?.instructions || ''}`.toLowerCase();
  const isBackendOrDevops = /api|endpoint|database|migration|server|auth|backend|supabase|deploy|ci\/cd|build|push|docker|nginx|vercel|infra|devops/.test(stepText);
  
  const touchesFrontend = inferred.changedFiles.some(f => 
    f.includes('src/components/') || 
    (f.includes('src/app/') && !f.includes('/api/')) || 
    f.endsWith('.css') || 
    f.includes('tailwind.config') ||
    f.includes('postcss.config')
  );

  const shouldRunVisual = params.shouldRunVisual ?? false; // Desactivado para el workflow principal, el QA se encarga de lo visual

  let runtimeProbe: Awaited<ReturnType<typeof runRuntimeProbe>> | null = null;
  try {
    runtimeProbe = await runRuntimeProbe({
      sandbox,
      pageRoutes: inferred.pageRoutes,
      apiRoutes: inferred.apiRoutes.map((a) => ({ path: a.path, method: a.method })),
      keepServerAlive: shouldRunVisual,
    });
    out.runtime = buildRuntimeSignalFromProbe(runtimeProbe);
    out.api = buildApiSignalFromProbe(runtimeProbe);
    if (!runtimeProbe.ok) {
      await logCronInfrastructureEvent(audit, {
        event: CronInfraEvent.RUNTIME_PROBE,
        level: 'error',
        message: `${stepOrder !== undefined ? `Step ${stepOrder} ` : ''}runtime probe: ${summarizeRuntimeProbe(runtimeProbe).slice(0, 400)}`,
        details: {
          stepOrder,
          ok: runtimeProbe.ok,
          port: runtimeProbe.port,
          pages: runtimeProbe.pages.map((p) => ({ path: p.path, status: p.http_status })),
          apis: runtimeProbe.apis.map((a) => ({ method: a.method, path: a.path, status: a.http_status })),
          server_errors: runtimeProbe.server_errors.slice(0, 10),
          startup_error: runtimeProbe.startup_error,
          changed_files: inferred.changedFiles.slice(0, 50),
          visual_planned: shouldRunVisual,
        },
      });
    }
    if (runtimeProbe.apis.length && !out.api?.ok) {
      await logCronInfrastructureEvent(audit, {
        event: CronInfraEvent.API_PROBE,
        level: 'warn',
        message: `${stepOrder !== undefined ? `Step ${stepOrder} ` : ''}api probe: ${runtimeProbe.apis.length} endpoint(s)`.slice(0, 400),
        details: {
          stepOrder,
          apis: runtimeProbe.apis.map((a) => ({
            method: a.method,
            path: a.path,
            status: a.http_status,
            ms: a.response_time_ms,
            ct: a.content_type,
          })),
        },
      });
    }
    if (!runtimeProbe.ok) {
      if (shouldRunVisual) await stopProbeServer(sandbox, runtimeProbe.port);
      return {
        ok: false,
        error: runtimeProbe.startup_error
          ? `Runtime probe: ${runtimeProbe.startup_error}`
          : `Runtime probe failed — ${summarizeRuntimeProbe(runtimeProbe)}`,
        signals: out,
      };
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn('[GateProbes] Runtime probe threw (non-fatal, proceeding to push):', msg);
    await logCronInfrastructureEvent(audit, {
      event: CronInfraEvent.RUNTIME_PROBE,
      level: 'warn',
      message: `${stepOrder !== undefined ? `Step ${stepOrder} ` : ''}runtime probe threw: ${msg.slice(0, 300)}`,
      details: { stepOrder, error: msg.slice(0, 800) },
    });
    return { ok: true, signals: out };
  }

  if (runtimeProbe && runtimeProbe.pages.length) {
    const hygiene = detectCopyHygieneIssues(runtimeProbe.pages);
    if (!hygiene.ok) {
      await logCronInfrastructureEvent(audit, {
        event: CronInfraEvent.COPY_HYGIENE,
        level: 'warn',
        message: `${stepOrder !== undefined ? `Step ${stepOrder} ` : ''}copy hygiene: ${hygiene.issues.length} leak(s)`.slice(0, 400),
        details: {
          stepOrder,
          ok: hygiene.ok,
          issues: hygiene.issues.slice(0, 10),
        },
      });
    }
    if (!hygiene.ok) {
      if (shouldRunVisual) await stopProbeServer(sandbox, runtimeProbe.port);
      return {
        ok: false,
        error: summarizeCopyHygiene(hygiene),
        signals: out,
      };
    }
  }

  if (!shouldRunVisual || !runtimeProbe) {
    return { ok: true, signals: out };
  }

  let gateBrowser: Browser | undefined;
  try {
    gateBrowser = await launchPuppeteerForGate();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn('[GateProbes] Puppeteer launch failed (skip e2e):', msg);
  }

  try {
    try {
      const visual = await runVisualProbe({
        sandbox,
        port: runtimeProbe.port,
        pageRoutes: inferred.pageRoutes,
        requirementId,
        stepOrder,
      });
      out.console = visual.console;
      out.visual = visual.visual_raw;
      await logCronInfrastructureEvent(audit, {
        event: CronInfraEvent.VISUAL_PROBE,
        level: visual.ok ? 'info' : 'warn',
        message: `${stepOrder !== undefined ? `Step ${stepOrder} ` : ''}visual probe: ${visual.screenshots.length} screenshot(s) at ${visual.base_url || 'n/a'}`.slice(0, 400),
        details: {
          stepOrder,
          ok: visual.ok,
          base_url: visual.base_url,
          screenshots: visual.screenshots.map((s) => ({ route: s.route, viewport: s.viewport, url: s.url })),
          error: visual.error,
        },
      });
      if (visual.console.entries.length || visual.console.page_errors.length || visual.console.failed_requests.length) {
        await logCronInfrastructureEvent(audit, {
          event: CronInfraEvent.CONSOLE_PROBE,
          level: visual.console.ok ? 'info' : 'warn',
          message: `${stepOrder !== undefined ? `Step ${stepOrder} ` : ''}console probe: ${visual.console.entries.length} entries, ${visual.console.page_errors.length} pageerror, ${visual.console.failed_requests.length} failed reqs`.slice(0, 400),
          details: {
            stepOrder,
            entries_sample: visual.console.entries.slice(0, 12),
            page_errors: visual.console.page_errors.slice(0, 6),
            failed_requests: visual.console.failed_requests.slice(0, 10),
          },
        });
      }
      if (!visual.console.ok) {
        return {
          ok: false,
          error: `Client runtime errors detected — see console/page_errors/failed_requests`,
          signals: out,
        };
      }
      if (visual.visual_raw.screenshots.length) {
        const critic = await runVisualCritic({
          screenshots: visual.visual_raw.screenshots,
          step: {
            order: stepOrder,
            title: stepContext?.title,
            instructions: stepContext?.instructions,
            expected_output: stepContext?.expected_output,
          },
          brand_context: stepContext?.brand_context,
        });
        out.visual = mergeCriticIntoVisualSignal(visual.visual_raw, critic);
        await logCronInfrastructureEvent(audit, {
          event: CronInfraEvent.VISUAL_CRITIC_VERDICT,
          level: critic.skipped ? 'warn' : critic.pass ? 'info' : 'warn',
          message: `${stepOrder !== undefined ? `Step ${stepOrder} ` : ''}visual critic: ${critic.skipped ? `skipped (${critic.skipped})` : critic.pass ? 'pass' : 'fail'} — ${critic.summary.slice(0, 200)}`.slice(0, 400),
          details: {
            stepOrder,
            pass: critic.pass,
            skipped: critic.skipped,
            summary: critic.summary,
            defects: critic.defects.slice(0, 20),
            model_used: critic.model_used,
          },
        });
        if (verdictBlocksGate(critic)) {
          return {
            ok: false,
            error: `Visual critic blocked gate — ${critic.summary.slice(0, 240)}`,
            signals: out,
          };
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('[GateProbes] Visual probe threw (non-fatal):', msg);
      await logCronInfrastructureEvent(audit, {
        event: CronInfraEvent.VISUAL_PROBE,
        level: 'warn',
        message: `${stepOrder !== undefined ? `Step ${stepOrder} ` : ''}visual probe threw: ${msg.slice(0, 300)}`,
        details: { stepOrder, error: msg.slice(0, 800) },
      });
    }

    try {
      const e2e = await runE2eScenarios({
        sandbox,
        port: runtimeProbe.port,
        requirementId,
        stepOrder,
        browser: gateBrowser,
      });
      if (e2e.scenarios_read > 0 || e2e.error) {
        out.scenarios = { ok: e2e.ok, scenarios: e2e.scenarios };
        const summary =
          e2e.scenarios.length > 0
            ? `${e2e.scenarios.filter((s) => s.pass).length}/${e2e.scenarios.length} pass`
            : (e2e.error ?? 'no scenario results').slice(0, 200);
        await logCronInfrastructureEvent(audit, {
          event: CronInfraEvent.SCENARIO_RUN,
          level: e2e.ok ? 'info' : 'warn',
          message: `${stepOrder !== undefined ? `Step ${stepOrder} ` : ''}e2e scenarios: ${summary}`.slice(0, 400),
          details: {
            stepOrder,
            scenarios_read: e2e.scenarios_read,
            base_url: e2e.base_url,
            scenarios: e2e.scenarios.map((s) => ({
              name: s.scenario,
              pass: s.pass,
              duration_ms: s.duration_ms,
              failed_step: s.steps.find((st) => !st.ok)?.index,
              failure: s.steps.find((st) => !st.ok)?.error,
            })),
            error: e2e.error,
          },
        });
        if (!e2e.ok) {
          return {
            ok: false,
            error: `E2E scenarios failed — ${e2e.scenarios.filter((s) => !s.pass).map((s) => s.scenario).join(', ') || e2e.error || 'unknown'}`.slice(
              0,
              500,
            ),
            signals: out,
          };
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('[GateProbes] E2E runner threw (non-fatal):', msg);
      await logCronInfrastructureEvent(audit, {
        event: CronInfraEvent.SCENARIO_RUN,
        level: 'warn',
        message: `${stepOrder !== undefined ? `Step ${stepOrder} ` : ''}e2e runner threw: ${msg.slice(0, 300)}`,
        details: { stepOrder, error: msg.slice(0, 800) },
      });
    }
  } finally {
    if (gateBrowser) await gateBrowser.close().catch(() => {});
    try {
      await stopProbeServer(sandbox, runtimeProbe.port);
    } catch {
      /* ignore */
    }
  }

  return { ok: true, signals: out };
}
