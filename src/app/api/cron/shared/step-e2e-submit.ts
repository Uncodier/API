import type { HTTPResponse, Page } from 'puppeteer-core';
import type { ScenarioAssertionReceipt } from '@/lib/services/requirement-evidence-types';

export type E2eSubmitStep = {
  action: 'submit';
  selector: string;
  response: {
    path: string;
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    expected_statuses: number[];
  };
};

type SubmitResult = {
  ok: boolean;
  error?: string;
  receipt?: ScenarioAssertionReceipt;
};

type BrowserSubmitProbe = {
  abort: AbortController;
};

type BrowserSubmitProbeWindow = Window & {
  __makinariSubmitProbes?: Record<string, BrowserSubmitProbe>;
};

function normalizedPath(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return normalized.replace(/\/+$/, '') || '/';
}

async function armSubmitProbe(
  page: Page,
  selector: string,
  marker: string,
  callbackName: string,
): Promise<boolean> {
  return page.evaluate(({ targetSelector, probeId, exposedCallback }) => {
    const element = document.querySelector(targetSelector);
    if (!(element instanceof HTMLElement)) return false;
    const control = element.closest('button, input') ?? element;
    const form = element instanceof HTMLFormElement
      ? element
      : (
          control instanceof HTMLButtonElement ||
          control instanceof HTMLInputElement
        )
        ? control.form
        : element.closest('form');
    if (!(form instanceof HTMLFormElement)) return false;

    const host = window as BrowserSubmitProbeWindow;
    const registry = (host.__makinariSubmitProbes ||= {});
    const abort = new AbortController();
    registry[probeId] = { abort };
    form.addEventListener('submit', (event) => {
      const submitter = event instanceof SubmitEvent
        ? event.submitter
        : null;
      if (control === form || submitter === control) {
        const callback = (
          host as unknown as Record<string, unknown>
        )[exposedCallback];
        if (typeof callback === 'function') void callback();
      }
    }, { capture: true, signal: abort.signal });
    return true;
  }, {
    targetSelector: selector,
    probeId: marker,
    exposedCallback: callbackName,
  });
}

async function removeSubmitProbe(
  page: Page,
  marker: string,
): Promise<void> {
  await page.evaluate((probeId) => {
    const host = window as BrowserSubmitProbeWindow;
    const registry = host.__makinariSubmitProbes;
    const probe = registry?.[probeId];
    if (!probe) return;
    probe.abort.abort();
    delete registry[probeId];
  }, marker);
}

export async function runE2eSubmitStep(
  page: Page,
  step: E2eSubmitStep,
  baseUrl: string,
  timeoutMs: number,
): Promise<SubmitResult> {
  if (!step.response.path.startsWith('/')) {
    return {
      ok: false,
      error: 'submit response.path must be an application-relative path',
    };
  }
  if (
    !step.response.expected_statuses.length ||
    step.response.expected_statuses.some(
      (status) => !Number.isInteger(status) || status < 100 || status > 599,
    )
  ) {
    return {
      ok: false,
      error: 'submit response.expected_statuses must contain valid HTTP statuses',
    };
  }

  const expectedMethod = (step.response.method || 'POST').toUpperCase();
  const expectedPath = normalizedPath(step.response.path);
  const expectedOrigin = new URL(baseUrl).origin;
  await page.waitForSelector(step.selector, { timeout: timeoutMs });
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const probeId = `submit-${suffix}`;
  const callbackName = `__makinariSubmit_${suffix}`;
  let submitted = false;
  await page.exposeFunction(callbackName, () => {
    submitted = true;
  });
  const controller = new AbortController();
  let response: HTTPResponse;
  let armed = false;
  try {
    armed = await armSubmitProbe(
      page,
      step.selector,
      probeId,
      callbackName,
    );
    if (!armed) {
      return {
        ok: false,
        error:
          `submit selector "${step.selector}" is not associated with a form`,
      };
    }
    [response] = await Promise.all([
      page.waitForResponse((candidate) => {
        if (!submitted) return false;
        const url = new URL(candidate.url());
        return (
          url.origin === expectedOrigin &&
          normalizedPath(url.pathname) === expectedPath &&
          candidate.request().method().toUpperCase() === expectedMethod
        );
      }, { timeout: timeoutMs, signal: controller.signal }),
      page.click(step.selector),
    ]);
  } finally {
    controller.abort();
    if (armed) await removeSubmitProbe(page, probeId).catch(() => undefined);
    await page.removeExposedFunction(callbackName).catch(() => undefined);
  }
  const actualStatus = response.status();
  const ok = step.response.expected_statuses.includes(actualStatus);
  return {
    ok,
    error: ok
      ? undefined
      : `response ${expectedMethod} ${expectedPath} returned ${actualStatus}; ` +
        `expected ${step.response.expected_statuses.join(', ')}`,
    receipt: {
      kind: 'http_response',
      pass: ok,
      method: expectedMethod,
      target: expectedPath,
      actual_status: actualStatus,
      expected_statuses: step.response.expected_statuses,
    },
  };
}
