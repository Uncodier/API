/**
 * Runtime + visual probes orchestrator used by runBuildAndOriginGate.
 *
 * Keeps the probe flow off the big gate file:
 *   1) infer target routes from git diff
 *   2) start next start inside the sandbox, hit pages + APIs
 *   3) if we're in an apps repo with real pages, keep the server alive and
 *      run the visual probe inside the sandbox against localhost
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
  type InteractionSignal,
  type RuntimeSignal,
  type ScenarioSignal,
  type VisualSignal,
} from './step-iteration-signals';
import { detectCopyHygieneIssues, summarizeCopyHygiene } from './step-copy-hygiene';
import type { GitRepoKind } from './cron-commit-helpers';
import type { Browser } from 'puppeteer-core';
import { launchPuppeteerForGate } from '@/lib/puppeteer/launch-gate-browser';
import { sanitizeRuntimeLog } from './runtime-log-context';
import {
  buildVisualProbePlan,
  formatVisualGateFeedback,
  inferProtectedVisualRoutes,
} from './step-visual-feedback';

export type ProbeSignals = {
  interaction?: InteractionSignal;
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
  changeBaselineSha?: string | null;
  stepContext?: {
    title?: string;
    instructions?: string;
    expected_output?: string;
    brand_context?: string;
  };
}): Promise<{
  ok: boolean;
  error?: string;
  infrastructureFailure?: boolean;
  signals: ProbeSignals;
}> {
  const {
    sandbox,
    stepOrder,
    requirementId,
    gitRepoKind,
    audit,
    stepContext,
    changeBaselineSha,
  } = params;
  const out: ProbeSignals = {};

  let inferred: Awaited<ReturnType<typeof inferTargetRoutesFromDiff>>;
  try {
    inferred = await inferTargetRoutesFromDiff(sandbox, {
      baselineSha: changeBaselineSha,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn('[GateProbes] inferTargetRoutesFromDiff threw:', msg);
    inferred = {
      pageRoutes: [],
      apiRoutes: [],
      changedFiles: [],
      recentPageRoutes: [],
      recentChangedFiles: [],
    };
  }

  const visualPlan = buildVisualProbePlan({
    explicit: params.shouldRunVisual,
    gitRepoKind,
    changedFiles: inferred.recentChangedFiles,
    inferredPageRoutes:
      params.shouldRunVisual === true
        ? Array.from(
            new Set([...inferred.recentPageRoutes, ...inferred.pageRoutes]),
          )
        : inferred.recentPageRoutes,
    stepContext,
  });
  const shouldRunVisual = visualPlan.enabled;
  const runtimePageRoutes = Array.from(
    new Set([...inferred.pageRoutes, ...(shouldRunVisual ? visualPlan.routes : [])]),
  );

  let runtimeProbe: Awaited<ReturnType<typeof runRuntimeProbe>> | null = null;
  try {
    runtimeProbe = await runRuntimeProbe({
      sandbox,
      pageRoutes: runtimePageRoutes,
      apiRoutes: inferred.apiRoutes.map((a) => ({ path: a.path, method: a.method })),
      keepServerAlive: shouldRunVisual,
    });
    const sanitizedServerLog = sanitizeRuntimeLog(runtimeProbe.server_log_tail);
    out.runtime = buildRuntimeSignalFromProbe({
      ...runtimeProbe,
      server_log_tail: sanitizedServerLog,
    });
    out.api = buildApiSignalFromProbe(runtimeProbe);
    if (!runtimeProbe.ok || runtimeProbe.server_errors.length > 0) {
      await logCronInfrastructureEvent(audit, {
        event: CronInfraEvent.RUNTIME_PROBE,
        level: runtimeProbe.ok ? 'warn' : 'error',
        message: `${stepOrder !== undefined ? `Step ${stepOrder} ` : ''}runtime probe: ${summarizeRuntimeProbe(runtimeProbe).slice(0, 400)}`,
        details: {
          stepOrder,
          ok: runtimeProbe.ok,
          port: runtimeProbe.port,
          pages: runtimeProbe.pages.map((p) => ({ path: p.path, status: p.http_status })),
          apis: runtimeProbe.apis.map((a) => ({ method: a.method, path: a.path, status: a.http_status })),
          server_errors: runtimeProbe.server_errors.slice(0, 10),
          server_log_excerpt: sanitizedServerLog,
          startup_error: runtimeProbe.startup_error,
          changed_files: inferred.changedFiles.slice(0, 50),
          visual_planned: shouldRunVisual,
          visual_plan_reason: visualPlan.reason,
          visual_routes: visualPlan.routes,
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
    console.warn('[GateProbes] Runtime probe infrastructure failure:', msg);
    await logCronInfrastructureEvent(audit, {
      event: CronInfraEvent.RUNTIME_PROBE,
      level: 'warn',
      message: `${stepOrder !== undefined ? `Step ${stepOrder} ` : ''}runtime probe threw: ${msg.slice(0, 300)}`,
      details: {
        stepOrder,
        error: sanitizeRuntimeLog(msg),
      },
    });
    return {
      ok: false,
      error: `Runtime probe infrastructure unavailable: ${msg}`,
      infrastructureFailure: true,
      signals: out,
    };
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
  if (visualPlan.runScenarios) {
    try {
      gateBrowser = await launchPuppeteerForGate();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('[GateProbes] Puppeteer launch failed (skip e2e):', msg);
    }
  }

  try {
    try {
      const visual = await runVisualProbe({
        sandbox,
        port: runtimeProbe.port,
        pageRoutes: visualPlan.routes,
        viewports: visualPlan.viewports,
        requirementId,
        stepOrder,
        fullPage: false,
        imageType: 'jpeg',
        imageQuality: 60,
        hydrationWaitMs: 500,
        pageTimeoutMs: 7_500,
        protectedRoutes: inferProtectedVisualRoutes(visualPlan.routes),
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
          plan_reason: visualPlan.reason,
          screenshots: visual.screenshots.map((s) => ({ route: s.route, viewport: s.viewport, url: s.url })),
          auth_redirects: visual.auth_redirects,
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
      if (!visual.visual_raw.ok) {
        return {
          ok: false,
          error: `Visual probe infrastructure unavailable: ${visual.error || 'capture batch incomplete'}`,
          infrastructureFailure: true,
          signals: out,
        };
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
          requirementId,
          maxScreenshots: 2,
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
        if (critic.skipped) {
          return {
            ok: false,
            error: `Visual critic infrastructure unavailable: ${critic.skipped}`,
            infrastructureFailure: true,
            signals: out,
          };
        }
        if (verdictBlocksGate(critic)) {
          return {
            ok: false,
            error: formatVisualGateFeedback(critic, visual.screenshots),
            signals: out,
          };
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('[GateProbes] Visual probe threw:', msg);
      await logCronInfrastructureEvent(audit, {
        event: CronInfraEvent.VISUAL_PROBE,
        level: 'warn',
        message: `${stepOrder !== undefined ? `Step ${stepOrder} ` : ''}visual probe threw: ${msg.slice(0, 300)}`,
        details: { stepOrder, error: msg.slice(0, 800) },
      });
      return {
        ok: false,
        error: `Visual probe infrastructure unavailable: ${msg}`,
        infrastructureFailure: true,
        signals: out,
      };
    }

    if (visualPlan.runScenarios) {
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
              error: (
                e2e.infrastructureFailure
                  ? `E2E infrastructure unavailable: ${e2e.error || 'unknown'}`
                  : `E2E scenarios failed — ${e2e.scenarios.filter((s) => !s.pass).map((s) => s.scenario).join(', ') || e2e.error || 'unknown'}`
              ).slice(0, 500),
              infrastructureFailure: e2e.infrastructureFailure,
              signals: out,
            };
          }
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('[GateProbes] E2E runner infrastructure failure:', msg);
        await logCronInfrastructureEvent(audit, {
          event: CronInfraEvent.SCENARIO_RUN,
          level: 'warn',
          message: `${stepOrder !== undefined ? `Step ${stepOrder} ` : ''}e2e runner threw: ${msg.slice(0, 300)}`,
          details: { stepOrder, error: msg.slice(0, 800) },
        });
        return {
          ok: false,
          error: `E2E infrastructure unavailable: ${msg}`,
          infrastructureFailure: true,
          signals: out,
        };
      }
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
