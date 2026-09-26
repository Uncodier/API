export type ToolOperationOutcome = 'passed' | 'failed' | 'unknown';

export interface NormalizedToolOperationResult {
  outcome: ToolOperationOutcome;
  payload: unknown;
  error?: {
    message: string;
    code?: string;
    path: string;
  };
}

const ENVELOPE_KEYS = ['cleanedResult', 'result', 'output', 'content'] as const;

function parseRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function errorMessage(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  const record = parseRecord(value);
  if (!record) return value == null ? undefined : String(value);
  const message = record.message ?? record.error ?? record.detail;
  return typeof message === 'string' && message.trim()
    ? message.trim()
    : JSON.stringify(record);
}

/**
 * Separates transport completion from operational success. Only known wrapper
 * fields are traversed so an error inside ordinary business data does not turn
 * an otherwise valid operation into a failure.
 */
export function normalizeToolOperationResult(
  value: unknown,
  options: { transportError?: boolean } = {},
): NormalizedToolOperationResult {
  const seen = new Set<unknown>();
  let explicitPass = false;

  if (options.transportError) {
    return {
      outcome: 'failed',
      payload: value,
      error: {
        message: errorMessage(value) || 'Tool execution failed.',
        path: '$',
      },
    };
  }

  const visit = (
    current: unknown,
    path: string,
  ): NormalizedToolOperationResult | undefined => {
    if (current == null || seen.has(current)) return undefined;
    seen.add(current);
    const record = parseRecord(current);
    if (!record) return undefined;

    const exitCodeValue = record.exitCode ?? record.exit_code;
    const exitCode = exitCodeValue === undefined ? undefined : Number(exitCodeValue);
    const httpStatusValue = record.statusCode ??
      (typeof record.status === 'number' ? record.status : undefined);
    const httpStatus = httpStatusValue === undefined
      ? undefined
      : Number(httpStatusValue);
    const status = typeof record.status === 'string'
      ? record.status.toLowerCase()
      : undefined;
    const failure = record.success === false || record.ok === false ||
      record.failed === true || record.error != null ||
      (Number.isFinite(exitCode) && exitCode !== 0) ||
      httpStatus === 404 || httpStatus === 410 ||
      status === 'failed' || status === 'error';
    if (failure) {
      const rawError = record.error ?? record.message ??
        (Number.isFinite(exitCode) ? `Command exited with code ${exitCode}` : current);
      return {
        outcome: 'failed',
        payload: current,
        error: {
          message: errorMessage(rawError) || 'Tool operation failed.',
          ...(typeof record.code === 'string' ? { code: record.code } : {}),
          path,
        },
      };
    }

    explicitPass = explicitPass || record.success === true || record.ok === true ||
      record.completed === true || status === 'succeeded' || status === 'completed' ||
      (Number.isFinite(exitCode) && exitCode === 0);

    for (const envelopeKey of ENVELOPE_KEYS) {
      if (record[envelopeKey] == null) continue;
      const nested = visit(record[envelopeKey], `${path}.${envelopeKey}`);
      if (nested?.outcome === 'failed') return nested;
    }
    return undefined;
  };

  const failure = visit(value, '$');
  if (failure) return failure;

  return {
    outcome: explicitPass ? 'passed' : 'unknown',
    payload: value,
  };
}

/** Preserve unknown outcomes in legacy success fields instead of reporting failure. */
export function toolOperationOutcomeToSuccess(
  outcome: ToolOperationOutcome | undefined,
): boolean | null {
  if (outcome === 'passed') return true;
  if (outcome === 'failed') return false;
  return null;
}

export function expectedToolReceiptKind(toolName: string): string | undefined {
  if (toolName === 'sandbox_db_inspect') return 'database_schema_snapshot';
  if (toolName === 'sandbox_db_migrate') return 'database_migration';
  return undefined;
}

export function hasExpectedToolReceipt(
  toolName: string,
  normalized: NormalizedToolOperationResult,
  expectedReceipt = expectedToolReceiptKind(toolName),
): boolean {
  if (!expectedReceipt) return true;
  const seen = new Set<unknown>();
  const findReceipt = (value: unknown): Record<string, unknown> | undefined => {
    if (value == null || seen.has(value)) return undefined;
    seen.add(value);
    const record = parseRecord(value);
    if (!record) return undefined;
    const receipt = parseRecord(record.receipt);
    if (receipt?.kind === expectedReceipt) return receipt;
    for (const envelopeKey of ENVELOPE_KEYS) {
      const nested = findReceipt(record[envelopeKey]);
      if (nested) return nested;
    }
    return undefined;
  };
  const receipt = findReceipt(normalized.payload);
  if (!receipt) return false;
  if (expectedReceipt === 'database_schema_snapshot') {
    return typeof receipt.schema === 'string' && !!receipt.schema &&
      typeof receipt.table === 'string' && !!receipt.table &&
      receipt.accessible === true;
  }
  if (expectedReceipt === 'database_migration') {
    return Array.isArray(receipt.applied) && receipt.pending === 0;
  }
  return true;
}