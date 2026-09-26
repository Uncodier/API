import { describe, expect, it } from '@jest/globals';
import {
  hasExpectedToolReceipt,
  normalizeToolOperationResult,
  toolOperationOutcomeToSuccess,
} from '../tool-operation-result';

describe('tool operation result normalization', () => {
  it('distinguishes transport success from a nested operational error', () => {
    expect(normalizeToolOperationResult({
      success: true,
      error: null,
      output: { error: 'permission denied', code: '42501' },
    })).toEqual({
      outcome: 'failed',
      payload: { error: 'permission denied', code: '42501' },
      error: {
        message: 'permission denied',
        code: '42501',
        path: '$.output',
      },
    });
  });

  it('checks every known envelope and gives failure precedence', () => {
    expect(normalizeToolOperationResult({
      success: true,
      result: { ok: true },
      output: { error: 'permission denied' },
    })).toMatchObject({
      outcome: 'failed',
      error: { message: 'permission denied', path: '$.output' },
    });
  });

  it('retains terminal HTTP statuses as operational failures', () => {
    expect(normalizeToolOperationResult({ status: 410, message: 'Gone' }))
      .toMatchObject({ outcome: 'failed' });
  });

  it('keeps empty or unasserted results unknown', () => {
    expect(normalizeToolOperationResult({ output: {} }).outcome).toBe('unknown');
    expect(normalizeToolOperationResult(undefined).outcome).toBe('unknown');
  });

  it('does not classify backlog business-data statuses as operation failures', () => {
    const result = {
      success: true,
      action: 'list',
      requirement_id: 'requirement-1',
      kind: 'app',
      backlog: {
        items: [
          { id: 'item-1', status: 'pending' },
          {
            id: 'item-2',
            status: 'needs_review',
            evidence: { status: 'failed', error: 'Previous verification failed' },
          },
        ],
      },
    };

    expect(normalizeToolOperationResult(result)).toEqual({
      outcome: 'passed',
      payload: result,
    });

    const { success, ...unassertedResult } = result;
    expect(normalizeToolOperationResult(unassertedResult)).toEqual({
      outcome: 'unknown',
      payload: unassertedResult,
    });
  });

  it('requires the operation-specific database receipt', () => {
    const missing = normalizeToolOperationResult({ success: true, output: {} });
    const present = normalizeToolOperationResult({
      success: true,
      receipt: {
        kind: 'database_schema_snapshot',
        schema: 'app_test',
        table: 'orders',
        accessible: true,
      },
    });
    expect(hasExpectedToolReceipt('sandbox_db_inspect', missing)).toBe(false);
    expect(hasExpectedToolReceipt('sandbox_db_inspect', present)).toBe(true);
    expect(hasExpectedToolReceipt(
      'sandbox_db_inspect',
      normalizeToolOperationResult({
        success: true,
        receipt: { kind: 'database_schema_snapshot' },
      }),
    )).toBe(false);
  });

  it('finds a receipt through the same nested envelopes as normalization', () => {
    const normalized = normalizeToolOperationResult({
      success: true,
      output: JSON.stringify({
        result: {
          receipt: {
            kind: 'database_schema_snapshot',
            schema: 'app_test',
            table: 'orders',
            accessible: true,
          },
        },
      }),
    });

    expect(hasExpectedToolReceipt('sandbox_db_inspect', normalized)).toBe(true);
  });
});

describe('tool operation outcome success mapping', () => {
  it.each([
    { outcome: 'passed' as const, success: true },
    { outcome: 'failed' as const, success: false },
    { outcome: 'unknown' as const, success: null },
    { outcome: undefined, success: null },
  ])('maps $outcome to $success', ({ outcome, success }) => {
    expect(toolOperationOutcomeToSuccess(outcome)).toBe(success);
  });
});