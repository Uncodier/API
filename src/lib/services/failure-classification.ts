import type { GateFailureCategory } from '@/app/api/cron/shared/step-iteration-signals';

export type FailureClass = 'product' | 'plumbing' | 'judge';

export interface ClassifiedFailure {
  failureClass: FailureClass;
  toolName?: string;
  category?: GateFailureCategory;
  countsTowardAttempts: boolean;
}

export type ClassifyFailureContext = {
  flow?: string;
  signals?: Array<{ name: string; ok: boolean }>;
  skipAttemptBump?: boolean;
};

function namedTool(preferred: string | undefined, fallback: string): string {
  const t = (preferred || '').trim();
  if (t && t.toLowerCase() !== 'unknown') return t;
  return fallback;
}

/**
 * Classifies an error string to determine if it is a product verification failure (which should
 * consume budget/attempts) or a plumbing failure (which should not).
 */
export function classifyFailure(
  errorText: string,
  categories?: GateFailureCategory[],
  ctx?: ClassifyFailureContext,
): ClassifiedFailure {
  const error = errorText.toLowerCase();
  const flowLabel = ctx?.flow ? `gate:${ctx.flow}` : 'gate:task';

  if (
    ctx?.skipAttemptBump
    || error.includes('inherited constraint')
    || error.includes('pre-existing line')
  ) {
    return {
      failureClass: 'plumbing',
      toolName: 'constraints',
      countsTowardAttempts: false,
    };
  }

  if (error.includes('judge_verdict') || error.includes('unmatched_constraint')) {
    return {
      failureClass: 'judge',
      toolName: 'judge',
      countsTowardAttempts: true,
    };
  }

  const signals = ctx?.signals || [];
  if (signals.length > 0) {
    const failed = signals.filter((s) => !s.ok);
    const onlyOrigin = failed.length > 0 && failed.every((s) => /origin|push|rebase/.test(s.name));
    if (onlyOrigin || /rebase|non-fast-forward|failed to push/.test(error)) {
      return {
        failureClass: 'product',
        toolName: 'origin',
        countsTowardAttempts: true,
      };
    }
    return {
      failureClass: 'product',
      toolName: namedTool(failed[0]?.name, flowLabel),
      category: categories?.[0],
      countsTowardAttempts: true,
    };
  }

  if (categories && categories.length > 0) {
    return {
      failureClass: 'product',
      category: categories[0],
      toolName: flowLabel,
      countsTowardAttempts: true,
    };
  }

  if (error.includes('gate_failed:') || error.includes('gate failed') || error.includes('failed gate')) {
    if (
      error.includes('build') ||
      error.includes('runtime') ||
      error.includes('api') ||
      error.includes('console') ||
      error.includes('scenario') ||
      error.includes('visual') ||
      error.includes('origin') ||
      error.includes('deploy') ||
      error.includes('constraint') ||
      error.includes('doc gate') ||
      error.includes('task gate')
    ) {
      const toolName = error.includes('origin') || error.includes('rebase') || error.includes('push')
        ? 'origin'
        : flowLabel;
      return {
        failureClass: 'product',
        toolName,
        countsTowardAttempts: true,
      };
    }
    return {
      failureClass: 'product',
      toolName: flowLabel,
      countsTowardAttempts: true,
    };
  }

  let toolName: string | undefined;
  const toolNameMatch = errorText.match(/Tool ([\w_:-]+) failed/i) ||
    errorText.match(/failed to call tool ([\w_:-]+)/i) ||
    errorText.match(/in tool ([\w_:-]+)/i) ||
    errorText.match(/tool_execution_failed.*?([\w_:-]+)/i);

  if (toolNameMatch && toolNameMatch[1] && toolNameMatch[1].toLowerCase() !== 'unknown') {
    toolName = toolNameMatch[1];
  } else if (
    error.includes('instance_plan') ||
    error.includes('execute_step') ||
    error.includes('missing step_id') ||
    error.includes('tool unknown failed')
  ) {
    toolName = 'instance_plan';
  } else if (error.includes('sandbox')) {
    toolName = 'sandbox';
  } else if (error.includes('origin') || error.includes('rebase') || error.includes('push')) {
    toolName = 'origin';
  }

  return {
    failureClass: 'plumbing',
    toolName: namedTool(toolName, 'sandbox'),
    countsTowardAttempts: false,
  };
}
