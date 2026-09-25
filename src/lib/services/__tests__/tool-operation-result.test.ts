import { describe, expect, it } from '@jest/globals';
import {
  hasExpectedToolReceipt,
  normalizeToolOperationResult,
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