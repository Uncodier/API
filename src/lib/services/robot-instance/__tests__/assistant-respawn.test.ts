import {
  evaluateInstanceStall,
  isIncompleteTurn,
  LOOKBACK_MS,
  MAX_RESPAWNS,
  RESPAWN_COOLDOWN_MS,
  STALL_MS,
  type StallLogRow,
} from '../assistant-respawn';

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    gte: jest.fn().mockReturnThis(),
    contains: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
  },
}));

jest.mock('workflow/api', () => ({
  start: jest.fn(),
}));

jest.mock('@/app/api/robots/instance/assistant/workflow', () => ({
  runAssistantWorkflow: jest.fn(),
}));

function minutesAgo(mins: number, nowMs: number) {
  return new Date(nowMs - mins * 60 * 1000).toISOString();
}

function log(partial: Partial<StallLogRow> & Pick<StallLogRow, 'log_type'>): StallLogRow {
  return {
    created_at: new Date().toISOString(),
    message: '',
    details: null,
    ...partial,
  };
}

describe('Assistant Respawn', () => {
  const nowMs = Date.parse('2026-08-28T18:00:00.000Z');

  describe('isIncompleteTurn', () => {
    it('returns true if !isDone', () => {
      expect(isIncompleteTurn({ isDone: false, text: 'some text' })).toBe(true);
    });

    it('returns true if text is empty', () => {
      expect(isIncompleteTurn({ isDone: true, text: '' })).toBe(true);
      expect(isIncompleteTurn({ isDone: true, text: '   ' })).toBe(true);
      expect(isIncompleteTurn({ isDone: true, text: null })).toBe(true);
      expect(isIncompleteTurn({ isDone: true })).toBe(true);
    });

    it('returns false if isDone and text is present', () => {
      expect(isIncompleteTurn({ isDone: true, text: 'I completed the task.' })).toBe(false);
    });
  });

  describe('evaluateInstanceStall', () => {
    it('respawns when last tool_call is older than 3 minutes', () => {
      const decision = evaluateInstanceStall({
        nowMs,
        recentRespawnCount: 0,
        logs: [log({ log_type: 'tool_call', created_at: minutesAgo(4, nowMs) })],
      });
      expect(decision).toBe('respawn');
    });

    it('skips when last tool_call is only 30s old', () => {
      const decision = evaluateInstanceStall({
        nowMs,
        recentRespawnCount: 0,
        logs: [log({ log_type: 'tool_call', created_at: minutesAgo(0.5, nowMs) })],
      });
      expect(decision).toBe('healthy_or_fresh');
    });

    it('skips when user_action is the latest interaction', () => {
      const decision = evaluateInstanceStall({
        nowMs,
        recentRespawnCount: 0,
        logs: [
          log({ log_type: 'user_action', message: 'continua', created_at: minutesAgo(1, nowMs) }),
          log({ log_type: 'tool_call', created_at: minutesAgo(5, nowMs) }),
        ],
      });
      expect(decision).toBe('has_user_action');
    });

    it('skips when max respawns already happened', () => {
      const decision = evaluateInstanceStall({
        nowMs,
        recentRespawnCount: MAX_RESPAWNS,
        logs: [log({ log_type: 'thinking', created_at: minutesAgo(4, nowMs) })],
      });
      expect(decision).toBe('max_respawns_reached');
    });

    it('skips when last respawn is inside the 2 minute cooldown', () => {
      const decision = evaluateInstanceStall({
        nowMs,
        recentRespawnCount: 1,
        logs: [
          log({
            log_type: 'infrastructure',
            created_at: minutesAgo(1, nowMs),
            details: { source: 'assistant_respawn' },
          }),
          log({ log_type: 'tool_call', created_at: minutesAgo(5, nowMs) }),
        ],
      });
      expect(decision).toBe('in_cooldown');
    });

    it('respawns empty agent_action older than stall window', () => {
      const decision = evaluateInstanceStall({
        nowMs,
        recentRespawnCount: 0,
        logs: [log({ log_type: 'agent_action', message: '   ', created_at: minutesAgo(4, nowMs) })],
      });
      expect(decision).toBe('respawn');
    });
  });

  describe('Constants', () => {
    it('uses the planned windows', () => {
      expect(STALL_MS).toBe(3 * 60 * 1000);
      expect(LOOKBACK_MS).toBe(30 * 60 * 1000);
      expect(RESPAWN_COOLDOWN_MS).toBe(2 * 60 * 1000);
      expect(MAX_RESPAWNS).toBe(2);
    });
  });
});
