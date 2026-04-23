/**
 * Declarative E2E scenario runner for per-step QA validation. Reads
 * `.qa/scenarios/*.json` from the sandbox working dir, drives puppeteer on the
 * host against sandbox.domain(VISUAL_PROBE_PORT), and returns typed results.
 *
 * Scenarios are intentionally small and composable — the QA persona authors
 * them and the gate runs them on every attempt.
 */

import type { Sandbox } from '@vercel/sandbox';
import type { Browser, Page } from 'puppeteer-core';
import { launchPuppeteerForGate } from '@/lib/puppeteer/launch-gate-browser';
import { SandboxService } from '@/lib/services/sandbox-service';
import type { ScenarioOutcome, ScenarioSignal, ScenarioStepOutcome } from './step-iteration-signals';

export type E2eGotoStep = {
  action: 'goto';
  path: string;
  wait_until?: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2';
};

export type E2eWaitForStep = {
  action: 'waitFor';
  selector?: string;
  timeout_ms?: number;
  text?: string;
};

export type E2eClickStep = {
  action: 'click';
  selector: string;
};

export type E2eFillStep = {
  action: 'fill';
  selector: string;
  value: string;
};

export type E2eExpectStep = {
  action: 'expect';
  selector?: string;
  exists?: boolean;
  text_contains?: string;
  text_equals?: string;
  min_count?: number;
  max_count?: number;
  attribute?: { name: string; equals?: string; contains?: string };
  status?: { eq?: number; lt?: number; gte?: number };
};

export type E2eSleepStep = {
  action: 'sleep';
  ms: number;
};

export type E2eStep =
  | E2eGotoStep
  | E2eWaitForStep
  | E2eClickStep
  | E2eFillStep
  | E2eExpectStep
  | E2eSleepStep;

export type E2eViewport = {
  name: string;
  width: number;
  height: number;
  isMobile?: boolean;
  deviceScaleFactor?: number;
};

export type E2eScenario = {
  name: string;
  description?: string;
  viewport?: E2eViewport;
  steps: E2eStep[];
};

export type E2eRunnerParams = {
  sandbox: Sandbox;
  port?: number;
  requirementId?: string;
  stepOrder: number;
  scenariosDir?: string;
  browser?: Browser;
  defaultTimeoutMs?: number;
};

export type E2eRunnerResult = ScenarioSignal & {
  scenarios_read: number;
  base_url: string;
  error?: string;
};

const DEFAULT_TIMEOUT = 15_000;
const DEFAULT_SCENARIOS_DIR = '.qa/scenarios';

async function readScenariosFromSandbox(sandbox: Sandbox, relDir: string): Promise<E2eScenario[]> {
  const wd = SandboxService.WORK_DIR;
  const listCmd = `cd ${wd} && if [ -d ${relDir} ]; then find ${relDir} -type f -name '*.json' | sort; fi`;
  const r = await sandbox.runCommand('sh', ['-c', listCmd]);
  if (r.exitCode !== 0) return [];
  const files = (await r.stdout().catch(() => ''))
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const scenarios: E2eScenario[] = [];
  for (const rel of files) {
    try {
      const buf = await sandbox.fs.readFile(`${wd}/${rel}`, 'utf8').catch(() => null);
      if (!buf) continue;
      const parsed = JSON.parse(typeof buf === 'string' ? buf : String(buf));
      const normalized = normalizeScenario(parsed, rel);
      if (normalized) scenarios.push(normalized);
    } catch {
      scenarios.push({
        name: rel,
        description: 'malformed scenario JSON',
        steps: [{ action: 'expect', selector: '__invalid__', exists: false }],
      });
    }
  }
  return scenarios;
}

function normalizeScenario(raw: unknown, fallbackName: string): E2eScenario | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === 'string' ? r.name : fallbackName;
  const description = typeof r.description === 'string' ? r.description : undefined;
  const viewport =
    r.viewport && typeof r.viewport === 'object' ? (r.viewport as E2eViewport) : undefined;
  const stepsRaw = Array.isArray(r.steps) ? r.steps : [];
  const steps = stepsRaw.filter((s) => s && typeof s === 'object' && typeof (s as { action?: unknown }).action === 'string') as E2eStep[];
  if (!steps.length) return null;
  return { name, description, viewport, steps };
}

async function runStep(
  page: Page,
  step: E2eStep,
  ctx: { baseUrl: string; defaultTimeoutMs: number; responseStatuses: number[] },
): Promise<{ ok: boolean; error?: string; dom_snippet?: string }> {
  try {
    switch (step.action) {
      case 'goto': {
        const target = `${ctx.baseUrl.replace(/\/$/, '')}${step.path.startsWith('/') ? step.path : `/${step.path}`}`;
        const resp = await page.goto(target, {
          waitUntil: step.wait_until || 'networkidle2',
          timeout: ctx.defaultTimeoutMs,
        });
        if (resp) ctx.responseStatuses.push(resp.status());
        return { ok: true };
      }
      case 'sleep': {
        await new Promise((r) => setTimeout(r, Math.max(0, step.ms)));
        return { ok: true };
      }
      case 'waitFor': {
        if (step.selector) {
          await page.waitForSelector(step.selector, { timeout: step.timeout_ms || ctx.defaultTimeoutMs });
          if (step.text) {
            const txt = await page.$eval(step.selector, (el) => el.textContent || '').catch(() => '');
            if (!txt.includes(step.text)) {
              return { ok: false, error: `selector ${step.selector} text did not contain "${step.text}"` };
            }
          }
          return { ok: true };
        }
        if (step.text) {
          await page.waitForFunction(
            (t: string) => !!document.body && (document.body.textContent || '').includes(t),
            { timeout: step.timeout_ms || ctx.defaultTimeoutMs },
            step.text,
          );
          return { ok: true };
        }
        return { ok: false, error: 'waitFor requires selector or text' };
      }
      case 'click': {
        await page.waitForSelector(step.selector, { timeout: ctx.defaultTimeoutMs });
        await page.click(step.selector);
        return { ok: true };
      }
      case 'fill': {
        await page.waitForSelector(step.selector, { timeout: ctx.defaultTimeoutMs });
        await page.focus(step.selector);
        await page.$eval(step.selector, (el) => {
          const node = el as HTMLInputElement | HTMLTextAreaElement;
          node.value = '';
        });
        await page.type(step.selector, step.value, { delay: 10 });
        return { ok: true };
      }
      case 'expect':
        return await runExpect(page, step, ctx);
      default:
        return { ok: false, error: `unknown action: ${(step as { action?: string }).action ?? 'undefined'}` };
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg.slice(0, 400) };
  }
}

async function runExpect(
  page: Page,
  step: E2eExpectStep,
  ctx: { responseStatuses: number[] },
): Promise<{ ok: boolean; error?: string; dom_snippet?: string }> {
  if (step.status) {
    const last = ctx.responseStatuses[ctx.responseStatuses.length - 1];
    if (last == null) return { ok: false, error: 'no response status recorded yet' };
    if (step.status.eq != null && last !== step.status.eq) {
      return { ok: false, error: `status ${last} != ${step.status.eq}` };
    }
    if (step.status.lt != null && !(last < step.status.lt)) {
      return { ok: false, error: `status ${last} >= ${step.status.lt}` };
    }
    if (step.status.gte != null && !(last >= step.status.gte)) {
      return { ok: false, error: `status ${last} < ${step.status.gte}` };
    }
    return { ok: true };
  }
  if (!step.selector) {
    return { ok: false, error: 'expect without selector/status' };
  }
  const handles = await page.$$(step.selector);
  if (step.exists === false) {
    if (handles.length) return { ok: false, error: `selector ${step.selector} found ${handles.length} (expected none)` };
    return { ok: true };
  }
  if (step.min_count != null && handles.length < step.min_count) {
    return { ok: false, error: `selector ${step.selector} count=${handles.length} < min ${step.min_count}` };
  }
  if (step.max_count != null && handles.length > step.max_count) {
    return { ok: false, error: `selector ${step.selector} count=${handles.length} > max ${step.max_count}` };
  }
  if (!handles.length) {
    return { ok: false, error: `selector ${step.selector} not found` };
  }
  if (step.text_contains || step.text_equals) {
    const text = await page.$eval(step.selector, (el) => el.textContent || '').catch(() => '');
    if (step.text_contains && !text.includes(step.text_contains)) {
      return { ok: false, error: `text did not contain "${step.text_contains}"; got "${text.slice(0, 160)}"` };
    }
    if (step.text_equals && text.trim() !== step.text_equals) {
      return { ok: false, error: `text != "${step.text_equals}"; got "${text.slice(0, 160)}"` };
    }
  }
  if (step.attribute) {
    const v = await page.$eval(
      step.selector,
      (el, name) => (el as Element).getAttribute(name as string),
      step.attribute.name,
    ).catch(() => null);
    if (step.attribute.equals != null && v !== step.attribute.equals) {
      return { ok: false, error: `attr ${step.attribute.name} != "${step.attribute.equals}"; got "${v}"` };
    }
    if (step.attribute.contains != null && (v == null || !v.includes(step.attribute.contains))) {
      return { ok: false, error: `attr ${step.attribute.name} did not contain "${step.attribute.contains}"; got "${v}"` };
    }
  }
  return { ok: true };
}

export async function runE2eScenarios(params: E2eRunnerParams): Promise<E2eRunnerResult> {
  const port = params.port ?? SandboxService.VISUAL_PROBE_PORT;
  const dir = params.scenariosDir ?? DEFAULT_SCENARIOS_DIR;
  const defaultTimeoutMs = params.defaultTimeoutMs ?? DEFAULT_TIMEOUT;

  let baseUrl = '';
  try {
    baseUrl = params.sandbox.domain(port);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: true,
      scenarios: [],
      scenarios_read: 0,
      base_url: '',
      error: `sandbox.domain(${port}) failed — port not exposed (${msg})`,
    };
  }

  const scenarios = await readScenariosFromSandbox(params.sandbox, dir);
  if (!scenarios.length) {
    return { ok: true, scenarios: [], scenarios_read: 0, base_url: baseUrl };
  }

  let browser: Browser | undefined = params.browser;
  let ownsBrowser = false;
  const outcomes: ScenarioOutcome[] = [];
  try {
    if (!browser) {
      try {
        browser = await launchPuppeteerForGate();
        ownsBrowser = true;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          ok: false,
          scenarios: [],
          scenarios_read: scenarios.length,
          base_url: baseUrl,
          error: `browser launch failed: ${msg.slice(0, 400)}`,
        };
      }
    }

    for (const scenario of scenarios) {
      const startedAt = Date.now();
      const page = await browser.newPage();
      page.setDefaultNavigationTimeout(defaultTimeoutMs);
      page.setDefaultTimeout(defaultTimeoutMs);
      if (scenario.viewport) {
        await page.setViewport({
          width: scenario.viewport.width,
          height: scenario.viewport.height,
          isMobile: !!scenario.viewport.isMobile,
          deviceScaleFactor: scenario.viewport.deviceScaleFactor ?? 1,
        });
      }

      const ctx = { baseUrl, defaultTimeoutMs, responseStatuses: [] as number[] };
      const stepOutcomes: ScenarioStepOutcome[] = [];
      let pass = true;
      for (let i = 0; i < scenario.steps.length; i++) {
        const step = scenario.steps[i];
        const res = await runStep(page, step, ctx);
        const outcome: ScenarioStepOutcome = {
          index: i,
          action: step.action,
          ok: res.ok,
          error: res.error,
        };
        if (!res.ok) {
          pass = false;
          const snippet = await captureDomSnippet(page).catch(() => undefined);
          outcome.artifacts = snippet ? { dom_snippet: snippet } : undefined;
          stepOutcomes.push(outcome);
          break;
        }
        stepOutcomes.push(outcome);
      }

      await page.close().catch(() => {});
      outcomes.push({
        scenario: scenario.name,
        pass,
        duration_ms: Date.now() - startedAt,
        steps: stepOutcomes,
      });
    }
  } finally {
    if (ownsBrowser && browser) await browser.close().catch(() => {});
  }

  const allOk = outcomes.every((o) => o.pass);
  return {
    ok: allOk,
    scenarios: outcomes,
    scenarios_read: scenarios.length,
    base_url: baseUrl,
  };
}

async function captureDomSnippet(page: Page): Promise<string> {
  const html = await page.content().catch(() => '');
  if (!html) return '';
  return html.slice(0, 800);
}
