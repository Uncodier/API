import type {
  ScenarioAssertionReceipt,
} from '@/lib/services/requirement-evidence-types';
import type {
  ProbeDisposition,
  ProbeObservation,
} from './step-probe-policy';
import { sanitizeRuntimeLog } from './runtime-log-context';

type ToolCall = {
  id?: string;
  toolCallId?: string;
  toolName?: string;
};

type ToolResult = {
  toolCallId?: string;
  result?: unknown;
  content?: unknown;
  output?: unknown;
};

type AssistantResult = {
  steps?: Array<{
    toolCalls?: ToolCall[];
    toolResults?: ToolResult[];
  }>;
};

export interface AgentProbeEvidence {
  observations: ProbeObservation[];
  scenario_assertions: ScenarioAssertionReceipt[];
}

const MUTATING_TOOLS = new Set([
  'sandbox_write_file',
  'sandbox_edit_file',
  'sandbox_delete_file',
]);

function record(value: unknown): Record<string, any> {
  if (value && typeof value === 'object') {
    return value as Record<string, any>;
  }
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object'
      ? parsed as Record<string, any>
      : {};
  } catch {
    return {};
  }
}

function disposition(
  status: number,
  declared: unknown,
): ProbeDisposition {
  if (
    declared === 'pass' ||
    declared === 'hard_fail' ||
    declared === 'unknown' ||
    declared === 'advisory'
  ) {
    return declared;
  }
  if (status === 0) return 'unknown';
  if (status === 401 || status === 403) return 'advisory';
  return status >= 200 && status < 400 ? 'pass' : 'hard_fail';
}

function httpMethod(value: unknown):
  | 'GET'
  | 'POST'
  | 'PUT'
  | 'DELETE'
  | 'PATCH' {
  const method = String(value || 'GET').toUpperCase();
  return ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(method)
    ? method as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
    : 'GET';
}

function probeObservations(
  payload: Record<string, any>,
): ProbeObservation[] {
  const apiObservations = (Array.isArray(payload.apis) ? payload.apis : [])
    .filter((api: any) => typeof api?.path === 'string')
    .map((api: any): ProbeObservation => {
      const method = httpMethod(api.method);
      const status = Number(api.http_status) || 0;
      const body = sanitizeRuntimeLog(
        typeof api.body_snippet === 'string' ? api.body_snippet : '',
      ).replace(/\s+/g, ' ').trim().slice(0, 300);
      return {
        kind: 'api',
        disposition: disposition(status, api.validation_disposition),
        source: 'agent_probe',
        target: `${method} ${api.path}`,
        detail:
          `HTTP ${status} collected by sandbox_probe_api` +
          (body ? `; body=${body}` : ''),
        method,
        http_status: status,
        ...(Array.isArray(api.expected_statuses)
          ? { expected_statuses: api.expected_statuses }
          : {}),
      };
    });
  const pageObservations = (Array.isArray(payload.pages) ? payload.pages : [])
    .filter((page: any) => typeof page?.path === 'string')
    .map((page: any): ProbeObservation => {
      const status = Number(page.http_status) || 0;
      return {
        kind: 'page',
        disposition: disposition(status, page.validation_disposition),
        source: 'agent_probe',
        target: page.path,
        detail: `HTTP ${status} collected by sandbox_probe_routes`,
        method: 'GET',
        http_status: status,
        ...(Array.isArray(page.expected_statuses)
          ? { expected_statuses: page.expected_statuses }
          : {}),
      };
    });
  return [...apiObservations, ...pageObservations];
}

function scenarioReceipts(
  payload: Record<string, any>,
): ScenarioAssertionReceipt[] {
  const receipts: ScenarioAssertionReceipt[] = [];
  for (const scenario of Array.isArray(payload.scenarios)
    ? payload.scenarios
    : []) {
    for (const step of Array.isArray(scenario?.steps) ? scenario.steps : []) {
      const receipt = step?.receipt;
      if (!receipt || receipt.pass !== true) continue;
      if (
        receipt.kind === 'http_response' &&
        typeof receipt.target === 'string' &&
        typeof receipt.actual_status === 'number' &&
        Array.isArray(receipt.expected_statuses)
      ) {
        receipts.push({
          kind: 'http_response',
          pass: true,
          method: httpMethod(receipt.method),
          target: receipt.target,
          actual_status: receipt.actual_status,
          expected_statuses: receipt.expected_statuses,
        });
      }
      if (
        receipt.kind === 'dom_assertion' &&
        typeof receipt.selector === 'string' &&
        typeof receipt.assertion === 'string'
      ) {
        receipts.push(receipt as ScenarioAssertionReceipt);
      }
    }
  }
  return receipts;
}

export function evidenceFromQaToolResult(
  toolName: string,
  payloadValue: unknown,
): AgentProbeEvidence {
  const payload = record(payloadValue);
  if (
    toolName === 'sandbox_probe_api' ||
    toolName === 'sandbox_probe_routes'
  ) {
    return {
      observations: probeObservations(payload),
      scenario_assertions: [],
    };
  }
  if (toolName === 'sandbox_run_scenario') {
    const receipts = scenarioReceipts(payload);
    return {
      scenario_assertions: receipts,
      observations: receipts
        .filter((receipt) => receipt.kind === 'http_response')
        .map((receipt): ProbeObservation => ({
          kind: 'api',
          disposition: 'pass',
          source: 'agent_probe',
          target: `${receipt.method} ${receipt.target}`,
          detail:
            `${receipt.method} ${receipt.target} returned ` +
            `${receipt.actual_status} in sandbox_run_scenario`,
          method: receipt.method,
          http_status: receipt.actual_status,
          expected_statuses: receipt.expected_statuses,
        })),
    };
  }
  return { observations: [], scenario_assertions: [] };
}

/**
 * Promotes trusted sandbox QA tool results into Judge evidence. A receipt is
 * discarded when a later tool mutates the workspace, matching test freshness
 * semantics and preventing stale probes from approving newer code.
 */
export function extractAgentProbeEvidence(
  result: AssistantResult,
): AgentProbeEvidence {
  const calls: Array<{
    name: string;
    payload: Record<string, any>;
  }> = [];
  for (const step of result.steps || []) {
    const results = new Map(
      (step.toolResults || []).map((toolResult) => [
        toolResult.toolCallId,
        toolResult,
      ]),
    );
    for (const toolCall of step.toolCalls || []) {
      const toolResult = results.get(toolCall.id || toolCall.toolCallId);
      calls.push({
        name: toolCall.toolName || '',
        payload: record(
          toolResult?.result ??
          toolResult?.output ??
          toolResult?.content,
        ),
      });
    }
  }

  let lastMutation = -1;
  calls.forEach((call, index) => {
    if (MUTATING_TOOLS.has(call.name)) lastMutation = index;
  });

  const observations: ProbeObservation[] = [];
  const scenarioAssertions: ScenarioAssertionReceipt[] = [];
  calls.forEach((call, index) => {
    if (index < lastMutation) return;
    if (
      call.name === 'sandbox_probe_api' ||
      call.name === 'sandbox_probe_routes'
    ) {
      const extracted = evidenceFromQaToolResult(call.name, call.payload);
      observations.push(...extracted.observations);
    }
    if (call.name === 'sandbox_run_scenario') {
      const extracted = evidenceFromQaToolResult(call.name, call.payload);
      scenarioAssertions.push(...extracted.scenario_assertions);
      observations.push(...extracted.observations);
    }
  });

  return {
    observations,
    scenario_assertions: scenarioAssertions,
  };
}
