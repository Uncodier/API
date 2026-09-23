import type {
  WorkflowToolExecution,
  WorkflowToolExecutionTracker,
} from './execution-tracker';

export type WorkflowPlanResultStatus = 'completed' | 'failed' | 'skipped';

export interface WorkflowPlanResultEvidence {
  type: 'tool' | 'url' | 'artifact' | 'observation';
  reference: string;
  description?: string;
  verified?: boolean;
}

export interface WorkflowPlanResultCheck {
  index: number;
  passed: boolean;
  evidence?: string;
}

export interface WorkflowPlanResult {
  status: WorkflowPlanResultStatus;
  summary: string;
  data: Record<string, unknown>;
  evidence: WorkflowPlanResultEvidence[];
  criteria: WorkflowPlanResultCheck[];
  validation: WorkflowPlanResultCheck[];
  executions: WorkflowToolExecution[];
  error?: {
    code?: string;
    message: string;
    retryable: boolean;
  };
  submitted_at: string;
}

export interface WorkflowPlanResultCapture {
  tool: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    execute: (args: unknown) => Promise<Record<string, unknown>>;
  };
  getResult: () => WorkflowPlanResult | null;
}

export interface WorkflowPlanResultCaptureOptions {
  executionTracker?: WorkflowToolExecutionTracker;
  requireToolExecution?: boolean;
  requiresBrowser?: boolean;
  requiredToolExecutions?: Array<{ tool: string; action?: string }>;
}

const MAX_RESULT_BYTES = 100_000;
const MAX_TEXT_LENGTH = 8_000;

function nonEmptyText(value: unknown, max = MAX_TEXT_LENGTH): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function normalizeChecks(value: unknown): WorkflowPlanResultCheck[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const source = item as Record<string, unknown>;
    const index = Number(source.index);
    if (!Number.isInteger(index) || index < 1) return [];
    const evidence = nonEmptyText(source.evidence);
    return [{
      index,
      passed: source.passed === true,
      ...(evidence ? { evidence } : {}),
    }];
  });
}

function normalizeEvidence(value: unknown): WorkflowPlanResultEvidence[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const source = item as Record<string, unknown>;
    const type = source.type;
    if (!['tool', 'url', 'artifact', 'observation'].includes(String(type))) {
      return [];
    }
    const reference = nonEmptyText(source.reference);
    if (!reference) return [];
    const description = nonEmptyText(source.description);
    return [{
      type: type as WorkflowPlanResultEvidence['type'],
      reference,
      ...(description ? { description } : {}),
    }];
  });
}

function missingOrFailedIndexes(
  expectedCount: number,
  checks: WorkflowPlanResultCheck[],
): number[] {
  const passed = new Set(
    checks.filter((check) => check.passed).map((check) => check.index),
  );
  return Array.from(
    { length: expectedCount },
    (_, index) => index + 1,
  ).filter((index) => !passed.has(index));
}

function meaningfulCriteriaCount(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  return value.filter((item) => String(item ?? '').trim()).length;
}

function meaningfulValidationCount(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  return value.filter((item) => {
    if (typeof item === 'string') return item.trim().length > 0;
    if (!item || typeof item !== 'object') return false;
    const source = item as Record<string, unknown>;
    return String(source.rule ?? source.name ?? '').trim().length > 0;
  }).length;
}

export function createWorkflowPlanResultCapture(step: {
  type?: string;
  expected_output?: unknown;
  success_criteria?: unknown;
  validation_rules?: unknown;
}, options: WorkflowPlanResultCaptureOptions = {}): WorkflowPlanResultCapture {
  let submitted: WorkflowPlanResult | null = null;
  const criteriaCount = meaningfulCriteriaCount(step.success_criteria);
  const validationCount = meaningfulValidationCount(step.validation_rules);

  const tool = {
    name: 'plan_result',
    description:
      'Submit the terminal, structured result for the current workflow step. ' +
      'This is the only valid way to complete, fail, or skip a workflow step. ' +
      'Call it once after the required actions finish. Never include passwords, tokens, cookies, or other secret values. ' +
      'For completed results, report every success criterion and validation rule by its 1-based index. ' +
      'The runner independently attaches the actual tool execution receipts.',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['completed', 'failed', 'skipped'],
        },
        summary: {
          type: 'string',
          description: 'Concise factual summary of what actually happened.',
        },
        data: {
          type: 'object',
          description:
            'Structured output matching expected_output. Use an empty object only when the step legitimately has no data output.',
          additionalProperties: true,
        },
        evidence: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['tool', 'url', 'artifact', 'observation'],
              },
              reference: {
                type: 'string',
                description: 'Tool name, URL, artifact ID, or concise observable fact.',
              },
              description: { type: 'string' },
            },
            required: ['type', 'reference'],
          },
        },
        criteria: {
          type: 'array',
          description: 'One entry for each success criterion, using its 1-based index.',
          items: {
            type: 'object',
            properties: {
              index: { type: 'number' },
              passed: { type: 'boolean' },
              evidence: { type: 'string' },
            },
            required: ['index', 'passed'],
          },
        },
        validation: {
          type: 'array',
          description: 'One entry for each validation rule, using its 1-based index.',
          items: {
            type: 'object',
            properties: {
              index: { type: 'number' },
              passed: { type: 'boolean' },
              evidence: { type: 'string' },
            },
            required: ['index', 'passed'],
          },
        },
        error: {
          type: 'object',
          properties: {
            code: { type: 'string' },
            message: { type: 'string' },
            retryable: { type: 'boolean' },
          },
          required: ['message', 'retryable'],
        },
      },
      required: ['status', 'summary', 'data', 'evidence', 'criteria', 'validation'],
    },
    execute: async (args: unknown): Promise<Record<string, unknown>> => {
      if (submitted) {
        return {
          accepted: false,
          terminal: true,
          error: 'plan_result was already submitted for this step.',
        };
      }
      if (!args || typeof args !== 'object') {
        return { accepted: false, terminal: false, error: 'A result object is required.' };
      }

      const source = args as Record<string, unknown>;
      const status = source.status as WorkflowPlanResultStatus;
      if (!['completed', 'failed', 'skipped'].includes(status)) {
        return { accepted: false, terminal: false, error: 'Invalid result status.' };
      }
      if (status === 'skipped' && step.type !== 'condition') {
        return {
          accepted: false,
          terminal: false,
          error: 'Only condition steps may report status="skipped".',
        };
      }

      const summary = nonEmptyText(source.summary);
      if (!summary) {
        return { accepted: false, terminal: false, error: 'summary is required.' };
      }
      const data =
        source.data && typeof source.data === 'object' && !Array.isArray(source.data)
          ? source.data as Record<string, unknown>
          : null;
      if (!data) {
        return { accepted: false, terminal: false, error: 'data must be an object.' };
      }

      const evidence = normalizeEvidence(source.evidence);
      const criteria = normalizeChecks(source.criteria);
      const validation = normalizeChecks(source.validation);
      const executions = options.executionTracker?.snapshot() || [];
      const successfulExecutions = executions.filter(
        (execution) => execution.status === 'succeeded',
      );
      const verifiedEvidence: WorkflowPlanResultEvidence[] =
        successfulExecutions.map((execution) => ({
          type: 'tool',
          reference: execution.id,
          description:
            `${execution.tool}${execution.action ? `:${execution.action}` : ''} succeeded`,
          verified: true,
        }));
      if (status === 'completed') {
        if (
          String(step.expected_output ?? '').trim() &&
          Object.keys(data).length === 0
        ) {
          return {
            accepted: false,
            terminal: false,
            error: 'Cannot complete: data is empty but expected_output is defined.',
          };
        }
        const missingCriteria = missingOrFailedIndexes(criteriaCount, criteria);
        const missingValidation = missingOrFailedIndexes(validationCount, validation);
        if (missingCriteria.length || missingValidation.length) {
          return {
            accepted: false,
            terminal: false,
            error:
              `Cannot complete: missing or failed success criteria [${missingCriteria.join(', ')}] ` +
              `and validation rules [${missingValidation.join(', ')}].`,
          };
        }
        if (
          (criteriaCount > 0 || validationCount > 0) &&
          evidence.length === 0 &&
          verifiedEvidence.length === 0
        ) {
          return {
            accepted: false,
            terminal: false,
            error: 'Completed results with declared checks require at least one evidence entry.',
          };
        }
        if (options.requireToolExecution && successfulExecutions.length === 0) {
          return {
            accepted: false,
            terminal: false,
            error: 'Cannot complete: no substantive tool execution succeeded.',
          };
        }
        const lastExecution = executions.at(-1);
        if (lastExecution && lastExecution.status !== 'succeeded') {
          return {
            accepted: false,
            terminal: false,
            error: `Cannot complete: latest tool execution ${lastExecution.id} did not succeed.`,
          };
        }
        if (options.requiresBrowser) {
          const browserActions = new Set(
            successfulExecutions
              .filter((execution) => execution.tool === 'sandbox_browser')
              .map((execution) => execution.action),
          );
          const missingBrowserActions = ['open', 'snapshot'].filter(
            (action) => !browserActions.has(action),
          );
          if (missingBrowserActions.length > 0) {
            return {
              accepted: false,
              terminal: false,
              error:
                `Cannot complete browser step: missing successful actions ` +
                `[${missingBrowserActions.join(', ')}].`,
            };
          }
        }
        const missingRequiredTools = (options.requiredToolExecutions || [])
          .filter((required) =>
            required && typeof required.tool === 'string' && required.tool.trim())
          .filter((required) => !successfulExecutions.some((execution) =>
            execution.tool === required.tool &&
            (!required.action || execution.action === required.action)))
          .map((required) =>
            `${required.tool}${required.action ? `:${required.action}` : ''}`);
        if (missingRequiredTools.length > 0) {
          return {
            accepted: false,
            terminal: false,
            error:
              `Cannot complete: missing successful required tool executions ` +
              `[${missingRequiredTools.join(', ')}].`,
          };
        }
      }

      let error: WorkflowPlanResult['error'];
      if (status === 'failed') {
        const rawError =
          source.error && typeof source.error === 'object'
            ? source.error as Record<string, unknown>
            : {};
        const message = nonEmptyText(rawError.message);
        if (!message) {
          return {
            accepted: false,
            terminal: false,
            error: 'error.message is required when status="failed".',
          };
        }
        const code = nonEmptyText(rawError.code, 200);
        error = {
          ...(code ? { code } : {}),
          message,
          retryable: rawError.retryable === true,
        };
      }

      const candidate: WorkflowPlanResult = {
        status,
        summary,
        data,
        evidence: [...evidence, ...verifiedEvidence],
        criteria,
        validation,
        executions,
        ...(error ? { error } : {}),
        submitted_at: new Date().toISOString(),
      };
      const serialized = JSON.stringify(candidate);
      if (Buffer.byteLength(serialized, 'utf8') > MAX_RESULT_BYTES) {
        return {
          accepted: false,
          terminal: false,
          error: `Structured result exceeds the ${MAX_RESULT_BYTES}-byte limit.`,
        };
      }

      submitted = candidate;
      return {
        accepted: true,
        terminal: true,
        status,
        message: 'Structured workflow result captured. Stop this step now.',
      };
    },
  };

  return {
    tool,
    getResult: () => submitted,
  };
}
