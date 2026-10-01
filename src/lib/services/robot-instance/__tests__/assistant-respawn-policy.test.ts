import { describe, expect, it } from '@jest/globals';
import {
  evaluateInstanceStall, isIncompleteTurn, LOOKBACK_MS, MAX_RESPAWNS,
  RESPAWN_COOLDOWN_MS, SILENT_CONTINUE_PROMPT, STALL_MS,
  type StallLogRow,
} from '../assistant-respawn-policy';

describe('workflow-safe assistant respawn policy', () => {
  const nowMs = Date.parse('2026-09-30T18:00:00.000Z');
  const row = (log_type: string, age: number, extra: Partial<StallLogRow> = {}): StallLogRow => ({
    log_type, created_at: new Date(nowMs - age).toISOString(), ...extra,
  });

  it.each([
    [{ isDone: false, text: 'Partial output' }, true],
    [{ isDone: true, text: '' }, true],
    [{ isDone: true, text: '   ' }, true],
    [{ isDone: true, text: null }, true],
    [{ isDone: true }, true],
    [{ isDone: true, text: 'Done' }, false],
  ])('classifies incomplete turns: %j', (result, expected) => {
    expect(isIncompleteTurn(result)).toBe(expected);
  });

  it.each([
    [[], 0, 'no_logs'],
    [[row('infrastructure', STALL_MS * 2)], 0, 'no_logs'],
    [[row('user_action', STALL_MS * 2)], 0, 'has_user_action'],
    [[row('tool_call', STALL_MS - 1)], 0, 'healthy_or_fresh'],
    [[row('tool_call', STALL_MS)], 0, 'respawn'],
    [[row('thinking', STALL_MS)], 0, 'respawn'],
    [[row('agent_action', STALL_MS, { message: '   ' })], 0, 'respawn'],
    [[row('agent_action', STALL_MS, { message: 'Done' })], 0, 'healthy_or_fresh'],
    [[row('thinking', STALL_MS)], MAX_RESPAWNS, 'max_respawns_reached'],
    [[row('infrastructure', RESPAWN_COOLDOWN_MS - 1, { details: { source: 'assistant_respawn' } }),
      row('tool_call', STALL_MS)], 1, 'in_cooldown'],
    [[row('infrastructure', RESPAWN_COOLDOWN_MS, { details: { source: 'assistant_respawn' } }),
      row('tool_call', STALL_MS)], 1, 'respawn'],
  ] as [StallLogRow[], number, string][])('evaluates stall policy: %j', (logs, recentRespawnCount, expected) => {
    expect(evaluateInstanceStall({ logs, recentRespawnCount, nowMs })).toBe(expected);
  });

  it('preserves the existing windows, limit and silent continuation marker', () => {
    expect(MAX_RESPAWNS).toBe(2);
    expect(STALL_MS).toBe(3 * 60 * 1000);
    expect(LOOKBACK_MS).toBe(30 * 60 * 1000);
    expect(RESPAWN_COOLDOWN_MS).toBe(2 * 60 * 1000);
    expect(SILENT_CONTINUE_PROMPT).toContain('previous execution was interrupted');
  });
});