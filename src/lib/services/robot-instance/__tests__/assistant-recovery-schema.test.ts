import { describe, expect, it } from '@jest/globals';
import {
  cloneRecoveryJson, MAX_RECOVERY_MESSAGES_BYTES, parseRecoveryCheckpoint,
  parseRecoveryExecution, parseRecoverySnapshot, RecoveryError,
} from '../assistant-recovery-schema';

const execution = { customTools: [], useSdkTools: true };
const snapshot = { version: 1, revision: '82b2dc7c-e6f4-4a59-a8bd-bfef1f099cfb', execution, messages: [], inFlight: false, respawnCount: 0 };

describe('lossless recovery serialization', () => {
  it('round trips every execution field and tool receipts without mutation or pruning', () => {
    const value = {
      ...execution,
      customTools: [{ type: 'function', function: { name: 'tool', parameters: { type: 'object' } } }],
      systemPrompt: 'Follow the instructions', agentType: 'copywriter', userPhone: '+15551234567',
      instanceNodeId: 'node', expectedResultsAmount: 2, contextString: 'Context',
      toolOverrides: { tool: { enabled: false } },
      selectedSkills: { skill_mode: 'required', skills: [{ slug: 'test', content: 'Skill', version: '1' }] },
      approvedImport: { url: 'https://example.com', sha256: 'a'.repeat(64), userId: 'user' },
    };
    const frozen = parseRecoveryExecution(value);
    expect(frozen).toEqual(value);
    expect(frozen).not.toBe(value);
    const checkpoint = { messages: [{ role: 'tool', tool_call_id: 'x', content: { success: true, receipt_id: 'posted' } }], continuation: { responseNodeIds: ['r1', 'r2'] } };
    expect(parseRecoveryCheckpoint(checkpoint)).toEqual(checkpoint);
  });

  it.each([
    () => 'function', undefined, Symbol('symbol'), BigInt(1), NaN, Infinity,
    new Date(), new Map(), new Set(), Buffer.from('secret'), /regexp/,
  ])('rejects a non-JSON value instead of coercing or losing it: %s', value => {
    expect(() => cloneRecoveryJson({ value }, MAX_RECOVERY_MESSAGES_BYTES)).toThrow(RecoveryError);
  });

  it('rejects cycles, sparse arrays, symbol keys, nonenumerable fields, and getters without invoking them', () => {
    const cycle: any = {}; cycle.self = cycle;
    let getterCalled = false;
    const getter = Object.defineProperty({}, 'receipt', { enumerable: true, get: () => { getterCalled = true; return 'x'; } });
    const values = [cycle, Array(3), { [Symbol('receipt')]: 'hidden' }, Object.defineProperty({}, 'receipt', { value: 'hidden' }), getter];
    for (const value of values) expect(() => cloneRecoveryJson(value, MAX_RECOVERY_MESSAGES_BYTES)).toThrow(RecoveryError);
    expect(getterCalled).toBe(false);
  });

  it('rejects dangerously deep state without stack overflow', () => {
    let value: any = {};
    for (let i = 0; i < 70; i++) value = { value };
    expect(() => cloneRecoveryJson(value, MAX_RECOVERY_MESSAGES_BYTES)).toThrow(RecoveryError);
  });

  it('permits shared subobjects and preserves __proto__ as data without prototype pollution', () => {
    const shared = { receipt: 'id' };
    expect(cloneRecoveryJson([shared, shared], 100)).toEqual([shared, shared]);
    const value = JSON.parse('{"__proto__":{"polluted":true}}');
    const cloned = cloneRecoveryJson(value, 100);
    expect(JSON.stringify(cloned)).toBe(JSON.stringify(value));
    expect(({} as any).polluted).toBeUndefined();
  });

  it.each(['data:image/png;base64,AAAA', 'prefix DATA:application/json,secret', '{"image":"data:image/png;base64,AA"}'])('rejects data URLs even within JSON receipt strings', value => {
    expect(() => parseRecoveryCheckpoint({ messages: [{ role: 'tool', content: value }] })).toThrow(RecoveryError);
  });

  it('permits ordinary data: text in instructions, code, and property names', () => {
    const value = { messages: [{ role: 'system', content: 'Return data: value. Type { data: Record<string, unknown> }', 'data:': 'not an inline URI' }] };
    expect(parseRecoveryCheckpoint(value)).toEqual(value);
  });

  it('preserves streaming provider thought signatures and omitted optional message properties', () => {
    const value = { messages: [{ role: 'assistant', content: null, tool_calls: [{
      id: 'call', type: 'function', function: { name: 'publish', arguments: '{}' },
      extra_content: { google: { thought_signature: 'opaque-base64-signature' } },
    }] }, { role: 'tool', tool_call_id: 'call', name: 'publish', content: '{"post_id":"once"}' }] };
    expect(parseRecoveryCheckpoint(value)).toEqual(value);
  });

  it('uses a 512 KiB byte cap, never a character cap or lossy truncation', () => {
    const exact = ['x'.repeat(MAX_RECOVERY_MESSAGES_BYTES - 4)];
    expect(Buffer.byteLength(JSON.stringify(exact))).toBe(MAX_RECOVERY_MESSAGES_BYTES);
    expect(parseRecoveryCheckpoint({ messages: exact }).messages).toEqual(exact);
    expect(() => parseRecoveryCheckpoint({ messages: ['x'.repeat(MAX_RECOVERY_MESSAGES_BYTES - 3)] })).toThrow(RecoveryError);
    expect(() => parseRecoveryCheckpoint({ messages: ['界'.repeat(180_000)] })).toThrow(RecoveryError);
  });

  it.each([
    {}, { ...execution, customTools: {} }, { ...execution, useSdkTools: 'true' },
    { ...execution, expectedResultsAmount: 0 }, { ...execution, expectedResultsAmount: 1.5 },
    { ...execution, instanceNodeId: '' }, { ...execution, toolOverrides: [] },
    { ...execution, selectedSkills: { content: undefined } },
    { ...execution, customTools: [{ execute: () => null }] },
    { ...execution, unknownOption: true },
  ])('rejects malformed execution %j', value => {
    expect(() => parseRecoveryExecution(value)).toThrow(RecoveryError);
  });

  it.each([
    { ...snapshot, revision: undefined }, { ...snapshot, revision: 'invalid' },
    { ...snapshot, version: 2 }, { ...snapshot, inFlight: 'false' },
    { ...snapshot, respawnCount: -1 }, { ...snapshot, respawnCount: 0.5 },
    { ...snapshot, messages: null }, { ...snapshot, lease_token: '' },
    { ...snapshot, nodeFingerprint: 'a'.repeat(64) },
    { ...snapshot, execution: { ...execution, instanceNodeId: 'node' } },
    { ...snapshot, continuation: { responseNodeIds: ['a', 'a'] } },
    { ...snapshot, continuation: { responseNodeIds: [null] } },
    { ...snapshot, continuation: { responseNodeIds: [], extra: true } },
    { ...snapshot, legacy: true },
  ])('rejects malformed persisted snapshot %j', value => {
    expect(() => parseRecoverySnapshot(value)).toThrow(RecoveryError);
  });

  it('supports valid node fingerprints and UUID leases while allowing count-limit checks at claim time', () => {
    const value = {
      ...snapshot, execution: { ...execution, instanceNodeId: 'node' },
      nodeFingerprint: 'f'.repeat(64), lease_token: 'a599c3ec-cbbe-4078-829f-3beff8bb8c7f', respawnCount: 2,
    };
    expect(parseRecoverySnapshot(value)).toEqual(value);
  });
});