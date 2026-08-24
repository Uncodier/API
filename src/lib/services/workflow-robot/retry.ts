export const DEFAULT_WORKFLOW_MAX_RETRIES = 2;

const LAST_OUTPUT_MAX = 8_000;
const TRIGGER_SNIPPET_MAX = 4_000;

export function resolveMaxRetries(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') {
    return DEFAULT_WORKFLOW_MAX_RETRIES;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_WORKFLOW_MAX_RETRIES;
  return Math.min(20, Math.floor(n));
}

/** After recording a failure, retry if retry_count is still below max_retries. */
export function canRetryStep(retryCount: number, maxRetries: number): boolean {
  return retryCount < maxRetries;
}

export function interpolateWorkflowText(text: string, ctx: Record<string, unknown>): string {
  if (!text) return text;
  return text.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, path) => {
    const parts = String(path).split('.');
    let cur: unknown = ctx;
    for (const p of parts) {
      if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
        cur = (cur as Record<string, unknown>)[p];
      } else {
        return `{{${path}}}`;
      }
    }
    if (cur == null) return '';
    return typeof cur === 'string' ? cur : JSON.stringify(cur);
  });
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}... [TRUNCATED, ${text.length - max} more chars]`;
}

export function buildWorkflowRetryContext(params: {
  errorMessage: string;
  retryCount: number;
  maxRetries: number;
  lastOutput?: string | null;
  step: { id: string; order?: number; title?: string };
  triggerSnippet?: string;
  historyText?: string;
  recoveryPlan?: string;
}): string {
  const attempt = params.retryCount + 1;
  const parts: string[] = [];

  parts.push(
    `🚨 PREVIOUS ATTEMPT FAILED 🚨\nThe previous execution of this step failed with the following error:\n\n${params.errorMessage}\n\nYou MUST fix this error during this execution attempt. Pay close attention to this validation failure.`,
  );
  parts.push(`Attempt: ${attempt} of ${params.maxRetries} (retry_count=${params.retryCount}/${params.maxRetries}).`);

  if (params.lastOutput?.trim()) {
    parts.push(`Last output from the failed attempt:\n${truncate(params.lastOutput.trim(), LAST_OUTPUT_MAX)}`);
  }

  parts.push(
    `Step: id=${params.step.id} order=${params.step.order ?? '?'} title=${params.step.title || ''}`,
  );

  if (params.triggerSnippet?.trim()) {
    parts.push(
      `Original trigger payload (do not ignore this event):\n${truncate(params.triggerSnippet.trim(), TRIGGER_SNIPPET_MAX)}`,
    );
  }

  if (params.historyText?.trim()) {
    parts.push(params.historyText.trim());
  }

  if (params.recoveryPlan?.trim()) {
    parts.push(
      `RECOVERY PLAN (use this on retry, not the original approach unless it still applies):\n${params.recoveryPlan.trim()}`,
    );
  }

  return `\n\n${parts.join('\n\n')}`;
}

export function formatWorkflowValidationPrompt(
  step: { success_criteria?: unknown; validation_rules?: unknown },
  interpolate: (text: string) => string,
): string {
  const criteria = Array.isArray(step.success_criteria)
    ? step.success_criteria.map((item) => String(item ?? '').trim()).filter(Boolean)
    : [];
  const rules = Array.isArray(step.validation_rules) ? step.validation_rules : [];
  const ruleLines: string[] = [];
  for (const raw of rules) {
    if (typeof raw === 'string') {
      const text = raw.trim();
      if (text) ruleLines.push(`- ${interpolate(text)}`);
      continue;
    }
    if (!raw || typeof raw !== 'object') continue;
    const rec = raw as Record<string, unknown>;
    const rule = String(rec.rule ?? rec.name ?? '').trim();
    if (!rule) continue;
    const value =
      rec.value != null && String(rec.value).trim() ? ` = ${interpolate(String(rec.value))}` : '';
    const req = rec.required === false ? ' (optional)' : ' (required)';
    ruleLines.push(`- ${interpolate(rule)}${value}${req}`);
  }
  if (criteria.length === 0 && ruleLines.length === 0) return '';
  const parts: string[] = [];
  if (criteria.length) {
    parts.push(`Success criteria:\n${criteria.map((c) => `- ${interpolate(c)}`).join('\n')}`);
  }
  if (ruleLines.length) {
    parts.push(`Validation rules:\n${ruleLines.join('\n')}`);
  }
  return `\nValidation (instructions for this step; there is no separate judge):\n${parts.join('\n\n')}\n`;
}
