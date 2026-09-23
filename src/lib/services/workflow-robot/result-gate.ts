import type { WorkflowToolExecution } from './execution-tracker';
import {
  parseWorkflowExpectedOutputContract,
  validateWorkflowOutputShape,
} from './result-shape';
import { workflowStepRequiresBrowserInteraction } from './browser-interaction';

export type WorkflowResultGateSeverity = 'error' | 'warning';

export interface WorkflowResultGateSignal {
  name: string;
  ok: boolean;
  detail: string;
  severity: WorkflowResultGateSeverity;
}

export interface WorkflowResultGateResult {
  ok: boolean;
  signals: WorkflowResultGateSignal[];
  reason?: string;
}

interface WorkflowResultGateInput {
  step: {
    title?: unknown;
    description?: unknown;
    instructions?: unknown;
    expected_output?: unknown;
    requires_browser?: unknown;
    browser_allowed_domains?: unknown;
    browser_interaction_required?: unknown;
    metadata?: Record<string, unknown>;
  };
  data: Record<string, unknown>;
  executions: WorkflowToolExecution[];
  requireToolExecution?: boolean;
  requiresBrowser?: boolean;
  requiredToolExecutions?: Array<{ tool: string; action?: string }>;
}

const BROWSER_INTERACTION_ACTIONS = new Set(['click', 'fill', 'type', 'press']);
const BROWSER_OBSERVATION_ACTIONS = new Set(['snapshot', 'get_text']);

function signal(
  name: string,
  ok: boolean,
  detail: string,
  severity: WorkflowResultGateSeverity = 'error',
): WorkflowResultGateSignal {
  return { name, ok, detail, severity };
}

function outputSignals(
  step: WorkflowResultGateInput['step'],
  data: Record<string, unknown>,
): WorkflowResultGateSignal[] {
  const expected = String(step.expected_output ?? '').trim();
  if (!expected) return [];

  const signals: WorkflowResultGateSignal[] = [];
  const populated = Object.keys(data).length > 0;
  signals.push(signal(
    'output-present',
    populated,
    populated
      ? `${Object.keys(data).length} top-level fields`
      : 'data is empty but expected_output is defined',
  ));
  const contract = parseWorkflowExpectedOutputContract(expected, step);
  if (contract.error) {
    signals.push(signal(
      'contract-format',
      false,
      contract.error,
    ));
    return signals;
  }
  if (contract.shape) {
    if (contract.repaired && contract.suggestion) {
      signals.push(signal(
        'contract-normalized',
        false,
        `Use the proposed contract: ${contract.suggestion}`,
        'warning',
      ));
    }
    signals.push(signal(
      'contract-format',
      true,
      contract.repaired
        ? 'legacy expected_output was normalized'
        : 'structured expected_output contract parsed',
    ));
    const issues = validateWorkflowOutputShape(contract.shape, data);
    signals.push(signal(
      'output-shape',
      issues.length === 0,
      issues.length === 0
        ? 'data matches the declared nested structure'
        : issues.join('; '),
    ));
  }
  return signals;
}

function executionSignals(
  input: WorkflowResultGateInput,
): WorkflowResultGateSignal[] {
  const signals: WorkflowResultGateSignal[] = [];
  const successful = input.executions.filter(
    (execution) => execution.status === 'succeeded',
  );

  if (input.requireToolExecution) {
    signals.push(signal(
      'tool-execution',
      successful.length > 0,
      successful.length > 0
        ? `${successful.length} substantive executions succeeded`
        : 'no substantive tool execution succeeded',
    ));
  }

  const lastExecution = input.executions.at(-1);
  if (lastExecution) {
    signals.push(signal(
      'latest-execution',
      lastExecution.status === 'succeeded',
      lastExecution.status === 'succeeded'
        ? `latest tool execution ${lastExecution.id} succeeded`
        : `latest tool execution ${lastExecution.id} ended with status=${lastExecution.status}`,
    ));
  }

  const required = (input.requiredToolExecutions || []).filter(
    (entry) => entry && typeof entry.tool === 'string' && entry.tool.trim(),
  );
  if (required.length > 0) {
    const missing = required.filter((entry) => !successful.some(
      (execution) =>
        execution.tool === entry.tool &&
        (!entry.action || execution.action === entry.action),
    ));
    signals.push(signal(
      'required-tools',
      missing.length === 0,
      missing.length === 0
        ? `${required.length} required executions succeeded`
        : `missing successful executions [${missing.map((entry) =>
          `${entry.tool}${entry.action ? `:${entry.action}` : ''}`).join(', ')}]`,
    ));
  }

  return signals;
}

function browserSignals(
  input: WorkflowResultGateInput,
): WorkflowResultGateSignal[] {
  const interactionRequiresBrowser =
    input.step.browser_interaction_required === true ||
    input.step.metadata?.browser_interaction_required === true;
  if (!input.requiresBrowser && !interactionRequiresBrowser) return [];

  const explicitlyEnabled =
    input.step.requires_browser === true ||
    input.step.metadata?.requires_browser === true;
  const allowedDomains = Array.isArray(input.step.browser_allowed_domains)
    ? input.step.browser_allowed_domains
    : input.step.metadata?.browser_allowed_domains;
  const successful = input.executions.filter(
    (execution) =>
      execution.status === 'succeeded' &&
      execution.tool === 'sandbox_browser',
  );
  const openIndex = successful.findIndex((execution) => execution.action === 'open');
  const initialSnapshotIndex = successful.findIndex(
    (execution, index) =>
      index > openIndex && execution.action === 'snapshot',
  );
  const navigated = openIndex >= 0 && initialSnapshotIndex > openIndex;
  const signals = [
    signal(
      'browser-contract',
      explicitlyEnabled,
      explicitlyEnabled
        ? 'requires_browser=true is explicit'
        : 'browser capability was enabled by legacy instruction inference',
      'warning',
    ),
    signal(
      'browser-domain-policy',
      Array.isArray(allowedDomains) && allowedDomains.length > 0,
      Array.isArray(allowedDomains) && allowedDomains.length > 0
        ? `${allowedDomains.length} browser domains declared`
        : 'browser_allowed_domains is empty; runtime browsing is not domain-scoped',
      'warning',
    ),
    signal(
      'browser-navigation',
      navigated,
      navigated
        ? 'open followed by snapshot'
        : 'browser steps require a successful open followed by snapshot',
    ),
  ];

  if (!workflowStepRequiresBrowserInteraction(input.step)) return signals;

  let interactionIndex = -1;
  for (let index = initialSnapshotIndex + 1; index < successful.length; index++) {
    if (BROWSER_INTERACTION_ACTIONS.has(successful[index]?.action || '')) {
      interactionIndex = index;
    }
  }
  const interacted = navigated && interactionIndex > initialSnapshotIndex;
  signals.push(signal(
    'browser-interaction',
    interacted,
    interacted
      ? `final ${successful[interactionIndex]?.action} executed after the initial snapshot`
      : 'instructions require a real browser interaction after the initial snapshot',
  ));

  const observationIndex = successful.findIndex(
    (execution, index) =>
      index > interactionIndex &&
      BROWSER_OBSERVATION_ACTIONS.has(execution.action || ''),
  );
  const observed = interacted && observationIndex > interactionIndex;
  signals.push(signal(
    'browser-post-interaction-observation',
    observed,
    observed
      ? `${successful[observationIndex]?.action} verified the resulting page state`
      : 'take a fresh snapshot or get_text after the browser interaction',
  ));
  return signals;
}

export function runWorkflowResultGate(
  input: WorkflowResultGateInput,
): WorkflowResultGateResult {
  const signals = [
    ...outputSignals(input.step, input.data),
    ...executionSignals(input),
    ...browserSignals(input),
  ];
  const failures = signals.filter(
    (entry) => !entry.ok && entry.severity === 'error',
  );
  return {
    ok: failures.length === 0,
    signals,
    ...(failures.length > 0
      ? {
        reason: `Workflow result gate failed: ${failures
          .map((entry) => `${entry.name}: ${entry.detail}`)
          .join('; ')}`,
      }
      : {}),
  };
}
