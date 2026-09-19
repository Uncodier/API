import type { Sandbox } from '@vercel/sandbox';
import {
  CronInfraEvent,
  logCronInfrastructureEvent,
  type CronAuditContext,
} from '@/lib/services/cron-audit-log';
import { launchPuppeteerForGate } from '@/lib/puppeteer/launch-gate-browser';
import { runE2eScenarios } from './step-e2e-runner';
import type { ScenarioSignal } from './step-iteration-signals';

export async function runExplicitE2eGate(params: {
  sandbox: Sandbox;
  port: number;
  requirementId: string;
  stepOrder: number;
  audit?: CronAuditContext;
}): Promise<{
  ok: boolean;
  error?: string;
  infrastructureFailure?: boolean;
  signal?: ScenarioSignal;
}> {
  let browser: Awaited<ReturnType<typeof launchPuppeteerForGate>> | undefined;
  try {
    try {
      browser = await launchPuppeteerForGate();
    } catch (error: unknown) {
      console.warn(
        '[GateProbes] Puppeteer launch failed (skip e2e):',
        error instanceof Error ? error.message : error,
      );
    }

    const e2e = await runE2eScenarios({
      sandbox: params.sandbox,
      port: params.port,
      requirementId: params.requirementId,
      stepOrder: params.stepOrder,
      browser,
    });
    const signal = e2e.scenarios_read > 0 || e2e.error
      ? { ok: e2e.ok, scenarios: e2e.scenarios }
      : undefined;
    if (signal) {
      const summary = e2e.scenarios.length > 0
        ? `${e2e.scenarios.filter((scenario) => scenario.pass).length}/${e2e.scenarios.length} pass`
        : (e2e.error ?? 'no scenario results').slice(0, 200);
      await logCronInfrastructureEvent(params.audit, {
        event: CronInfraEvent.SCENARIO_RUN,
        level: e2e.ok ? 'info' : 'warn',
        message:
          `Step ${params.stepOrder} e2e scenarios: ${summary}`.slice(0, 400),
        details: {
          stepOrder: params.stepOrder,
          scenarios_read: e2e.scenarios_read,
          base_url: e2e.base_url,
          scenarios: e2e.scenarios.map((scenario) => ({
            name: scenario.scenario,
            pass: scenario.pass,
            duration_ms: scenario.duration_ms,
            failed_step: scenario.steps.find((step) => !step.ok)?.index,
            failure: scenario.steps.find((step) => !step.ok)?.error,
          })),
          error: e2e.error,
        },
      });
    }
    if (!e2e.ok) {
      return {
        ok: false,
        error: (
          e2e.infrastructureFailure
            ? `E2E infrastructure unavailable: ${e2e.error || 'unknown'}`
            : `E2E scenarios failed — ${
              e2e.scenarios
                .filter((scenario) => !scenario.pass)
                .map((scenario) => scenario.scenario)
                .join(', ') ||
              e2e.error ||
              'unknown'
            }`
        ).slice(0, 500),
        infrastructureFailure: e2e.infrastructureFailure,
        signal,
      };
    }
    return { ok: true, signal };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[GateProbes] E2E runner infrastructure failure:', message);
    await logCronInfrastructureEvent(params.audit, {
      event: CronInfraEvent.SCENARIO_RUN,
      level: 'warn',
      message:
        `Step ${params.stepOrder} e2e runner threw: ${message.slice(0, 300)}`,
      details: {
        stepOrder: params.stepOrder,
        error: message.slice(0, 800),
      },
    });
    return {
      ok: false,
      error: `E2E infrastructure unavailable: ${message}`,
      infrastructureFailure: true,
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
