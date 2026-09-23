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
import { sanitizeRuntimeLog } from './runtime-log-context';
import { runExplicitE2eGate } from './step-e2e-gate';
import {
  buildVisualProbePlan,
  extractPageRoutesFromStepContext,
  formatVisualGateFeedback,
  resolveProtectedVisualRoutes,
} from './step-visual-feedback';
import {
  buildRuntimeTargetPlan,
  evaluateRuntimeProbe,
  type ProbeObservation,
} from './step-probe-policy';

export type ProbeSignals = {
  interaction?: InteractionSignal;
  runtime?: RuntimeSignal;
  api?: ApiSignal;
  console?: ConsoleSignal;
  visual?: VisualSignal;
  scenarios?: ScenarioSignal;
  observations?: ProbeObservation[];
};

export async function runRuntimeAndVisualProbes(params: {
  sandbox: Sandbox;
  stepOrder: number;
  requirementId: string;
  gitRepoKind: GitRepoKind;
  audit?: CronAuditContext;
  shouldRunVisual?: boolean;
  /** Probe only declared validation targets/protected routes, without diff inference or visuals. */
  declaredOnly?: boolean;
  changeBaselineSha?: string | null;
  stepContext?: {
    title?: string;
    instructions?: string;
    expected_output?: string;
    brand_context?: string;
    protected_routes?: string[];
    validation_targets?: unknown;
    acceptance?: string[];
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
  const explicitVisual =
    params.declaredOnly !== true && params.shouldRunVisual === true;

  let inferred: Awaited<ReturnType<typeof inferTargetRoutesFromDiff>>;
  if (params.declaredOnly) {
    inferred = {
      pageRoutes: [],
      apiRoutes: [],
      changedFiles: [],
      recentPageRoutes: [],
      recentChangedFiles: [],
    };
  } else {
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
  }

  const visualPlan = buildVisualProbePlan({
    explicit: params.declaredOnly ? false : params.shouldRunVisual,
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
  const inferredPageRoutes = explicitVisual
    ? Array.from(new Set([...inferred.recentPageRoutes, ...inferred.pageRoutes]))
    : inferred.recentPageRoutes;
  const targetPlan = buildRuntimeTargetPlan({
    validationTargets: stepContext?.validation_targets,
    acceptance: stepContext?.acceptance,
    protectedRoutes: stepContext?.protected_routes,
    proseRoutes: params.declaredOnly
      ? []
      : extractPageRoutesFromStepContext(stepContext),
    inferredPageRoutes,
    inferredApiRoutes: inferred.apiRoutes,
  });
  const runtimePageRoutes = targetPlan.pages.map((target) => target.path);
  out.observations = [...targetPlan.observations];

  let runtimeProbe: Awaited<ReturnType<typeof runRuntimeProbe>> | null = null;
  try {
    runtimeProbe = await runRuntimeProbe({
      sandbox,
      pageRoutes: runtimePageRoutes,
      apiRoutes: targetPlan.apis.map((target) => ({
        path: target.path,
        method: target.method,
        payload: target.payload,
        payload_source: target.source === 'contract' ? 'scenario' : 'inferred',
      })),
      keepServerAlive: shouldRunVisual,
    });
    const evaluated = evaluateRuntimeProbe(runtimeProbe, targetPlan);
    runtimeProbe = {
      ...runtimeProbe,
      ok: runtimeProbe.ok && !evaluated.hardFailure,
      pages: evaluated.pages,
      apis: evaluated.apis,
    };
    out.observations = evaluated.observations;
    const sanitizedServerLog = sanitizeRuntimeLog(runtimeProbe.server_log_tail);
    out.runtime = buildRuntimeSignalFromProbe({
      ...runtimeProbe,
      server_log_tail: sanitizedServerLog,
    });
    out.api = buildApiSignalFromProbe(runtimeProbe);
    const noteworthyObservations = (out.observations || []).filter(
      (observation) => observation.disposition !== 'pass',
    );
    if (
      !runtimeProbe.ok ||
      runtimeProbe.server_errors.length > 0 ||
      noteworthyObservations.length > 0
    ) {
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
          observations: out.observations.slice(0, 30),
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
      out.observations?.push({
        kind: 'copy',
        disposition: 'advisory',
        source: 'diff',
        detail: summarizeCopyHygiene(hygiene),
      });
    }
  }

  if (!shouldRunVisual || !runtimeProbe) {
    return { ok: true, signals: out };
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
        protectedRoutes: resolveProtectedVisualRoutes(
          visualPlan.routes,
          stepContext?.protected_routes,
        ),
      });
      out.console = visual.console;
      out.visual = visual.visual_raw;
      await logCronInfrastructureEvent(audit, {
        event: CronInfraEvent.VISUAL_PROBE,
        level: visual.capture_ok ? 'info' : 'warn',
        message: `${stepOrder !== undefined ? `Step ${stepOrder} ` : ''}visual probe: ${visual.screenshots.length} screenshot(s) at ${visual.base_url || 'n/a'}`.slice(0, 400),
        details: {
          stepOrder,
          ok: visual.ok,
          capture_ok: visual.capture_ok,
          console_ok: visual.console.ok,
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
      if (!visual.capture_ok || !visual.visual_raw.ok) {
        out.observations?.push({
          kind: 'visual',
          disposition: 'unknown',
          source: explicitVisual ? 'contract' : 'diff',
          detail: visual.error || 'capture batch incomplete',
        });
        if (!explicitVisual) {
          return { ok: true, signals: out };
        }
        return {
          ok: false,
          error: `Visual probe infrastructure unavailable: ${visual.error || 'capture batch incomplete'}`,
          infrastructureFailure: true,
          signals: out,
        };
      }
      if (!visual.console.ok) {
        out.observations?.push({
          kind: 'console',
          disposition: explicitVisual ? 'hard_fail' : 'advisory',
          source: explicitVisual ? 'contract' : 'diff',
          detail:
            visual.error ||
            'Client runtime errors detected in the automatic browser probe.',
        });
        if (!explicitVisual) {
          return { ok: true, signals: out };
        }
        return {
          ok: false,
          error:
            visual.error ||
            'Client runtime errors detected. Inspect console entries, page errors, and failed requests.',
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
          level: critic.status === 'unavailable' ? 'warn' : critic.pass ? 'info' : 'warn',
          message: `${stepOrder !== undefined ? `Step ${stepOrder} ` : ''}visual critic: ${critic.status === 'unavailable' ? `unavailable (${critic.skipped || 'unknown'})` : critic.pass ? 'pass' : 'fail'} — ${critic.summary.slice(0, 200)}`.slice(0, 400),
          details: {
            stepOrder,
            status: critic.status,
            pass: critic.pass,
            skipped: critic.skipped,
            summary: critic.summary,
            defects: critic.defects.slice(0, 20),
            model_used: critic.model_used,
            completion_attempts: critic.completion_attempts,
            finish_reason: critic.finish_reason,
            response_format: critic.response_format,
            response_excerpt: critic.response_excerpt,
          },
        });
        if (critic.status === 'unavailable') {
          out.observations?.push({
            kind: 'visual',
            disposition: 'unknown',
            source: explicitVisual ? 'contract' : 'diff',
            detail: `Visual critic unavailable: ${critic.skipped || 'unknown'}`,
          });
          if (!explicitVisual) {
            return { ok: true, signals: out };
          }
          return {
            ok: false,
            error: `Visual critic infrastructure unavailable: ${critic.skipped}`,
            infrastructureFailure: true,
            signals: out,
          };
        }
        if (verdictBlocksGate(critic)) {
          const feedback = formatVisualGateFeedback(critic, visual.screenshots);
          out.observations?.push({
            kind: 'visual',
            disposition: explicitVisual ? 'hard_fail' : 'advisory',
            source: explicitVisual ? 'contract' : 'diff',
            detail: feedback,
          });
          if (!explicitVisual) {
            return { ok: true, signals: out };
          }
          return {
            ok: false,
            error: feedback,
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
      out.observations?.push({
        kind: 'visual',
        disposition: 'unknown',
        source: explicitVisual ? 'contract' : 'diff',
        detail: `Visual probe unavailable: ${msg}`,
      });
      if (!explicitVisual) {
        return { ok: true, signals: out };
      }
      return {
        ok: false,
        error: `Visual probe infrastructure unavailable: ${msg}`,
        infrastructureFailure: true,
        signals: out,
      };
    }

    if (visualPlan.runScenarios) {
      const e2e = await runExplicitE2eGate({
        sandbox,
        port: runtimeProbe.port,
        requirementId,
        stepOrder,
        audit,
      });
      if (e2e.signal) out.scenarios = e2e.signal;
      if (!e2e.ok) {
        return {
          ok: false,
          error: e2e.error,
          infrastructureFailure: e2e.infrastructureFailure,
          signals: out,
        };
      }
    }
  } finally {
    try {
      await stopProbeServer(sandbox, runtimeProbe.port);
    } catch {
      /* ignore */
    }
  }

  return { ok: true, signals: out };
}
