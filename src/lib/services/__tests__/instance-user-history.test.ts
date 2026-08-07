import { buildUserHistoryPrompt, loadUserActionHistory } from '../instance-user-history';

const mockRange = jest.fn();
const mockMaybeSingle = jest.fn();
const mockLimit = jest.fn();

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn((table: string) => {
      if (table === 'requirements') {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          maybeSingle: (...args: unknown[]) => mockMaybeSingle(...args),
        };
      }
      if (table === 'requirement_status') {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          not: jest.fn().mockReturnThis(),
          limit: (...args: unknown[]) => mockLimit(...args),
        };
      }
      // instance_logs
      return {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        in: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
        range: (...args: unknown[]) => mockRange(...args),
      };
    }),
  },
}));

describe('buildUserHistoryPrompt', () => {
  const createMessages = (count: number, charSize = 10) =>
    Array.from({ length: count }, (_, i) => ({
      id: `msg-${i}`,
      created_at: new Date(1_000_000 + i * 1000).toISOString(),
      message: 'A'.repeat(charSize),
    }));

  it('returns empty mode when no messages exist', () => {
    const result = buildUserHistoryPrompt([]);
    expect(result.mode).toBe('empty');
    expect(result.totalCount).toBe(0);
  });

  it('returns full mode when messages fit in budget', () => {
    const messages = createMessages(10, 100);
    const result = buildUserHistoryPrompt(messages, { maxTotalBytes: 2000 });
    expect(result.mode).toBe('full');
    expect(result.totalCount).toBe(10);
    expect(result.promptText).toContain('=== USER MESSAGE HISTORY (ALL) ===');
  });

  it('windows even when message count is small but bodies blow the budget', () => {
    // 3 messages × 5KB = 15KB > 2KB budget, count < headN+tailN
    const messages = Array.from({ length: 3 }, (_, i) => ({
      id: `msg-${i}`,
      created_at: new Date(1_000_000 + i * 1000).toISOString(),
      message: `CONTENT_${i}_`.padEnd(5000, 'X'),
    }));

    const result = buildUserHistoryPrompt(messages, {
      maxTotalBytes: 2000,
      headN: 5,
      tailN: 10,
      maxMessageBytes: 16_000,
    });

    expect(result.mode).toBe('windowed');
    expect(result.promptText).toContain('WINDOWED');
    expect(result.promptText).toContain('CONTENT_0_');
  });

  it('returns windowed mode when over budget with many messages', () => {
    const messages = Array.from({ length: 10 }, (_, i) => ({
      id: `msg-${i}`,
      created_at: new Date(1_000_000 + i * 1000).toISOString(),
      message: `CONTENT_${i}`.padEnd(500, 'X'),
    }));

    const result = buildUserHistoryPrompt(messages, {
      maxTotalBytes: 1000,
      headN: 2,
      tailN: 2,
    });

    expect(result.mode).toBe('windowed');
    expect(result.promptText).toContain('CONTENT_0');
    expect(result.promptText).toContain('CONTENT_1');
    expect(result.promptText).not.toContain('CONTENT_2'.padEnd(500, 'X'));
    expect(result.promptText).toContain('CONTENT_8');
    expect(result.promptText).toContain('CONTENT_9');
  });

  it('clamps pathological single messages', () => {
    const messages = [
      {
        id: 'big',
        created_at: new Date().toISOString(),
        message: 'Z'.repeat(50_000),
      },
    ];
    const result = buildUserHistoryPrompt(messages, { maxMessageBytes: 1000, maxTotalBytes: 32_000 });
    expect(Buffer.byteLength(result.messages[0].message, 'utf-8')).toBeLessThanOrEqual(1020);
    expect(result.messages[0].message).toContain('[truncated]');
  });
});

describe('loadUserActionHistory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLimit.mockResolvedValue({ data: [], error: null });
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
  });

  it('paginates until a short page', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: `msg-${i}`,
      created_at: new Date(1_000_000 + i * 1000).toISOString(),
      message: 'A'.repeat(10),
      instance_id: 'inst-1',
    }));
    const page2 = Array.from({ length: 50 }, (_, i) => ({
      id: `msg-${100 + i}`,
      created_at: new Date(2_000_000 + i * 1000).toISOString(),
      message: 'B'.repeat(10),
      instance_id: 'inst-1',
    }));

    mockRange
      .mockResolvedValueOnce({ data: page1, error: null })
      .mockResolvedValueOnce({ data: page2, error: null });

    const result = await loadUserActionHistory('inst-1');
    expect(mockRange).toHaveBeenCalledTimes(2);
    expect(result.totalCount).toBe(150);
    expect(result.mode).toBe('full');
  });

  it('resolves related instances when requirementId is provided', async () => {
    mockLimit.mockResolvedValueOnce({
      data: [{ instance_id: 'chat-inst' }],
      error: null,
    });
    mockMaybeSingle.mockResolvedValueOnce({
      data: { metadata: { runner_instance_id: 'runner-inst' } },
      error: null,
    });
    mockRange.mockResolvedValueOnce({
      data: [
        {
          id: 'ua-1',
          created_at: new Date().toISOString(),
          message: 'Necesito una cotización',
          instance_id: 'chat-inst',
        },
      ],
      error: null,
    });

    const result = await loadUserActionHistory('runner-inst', {
      requirementId: 'req-123',
    });

    expect(result.totalCount).toBe(1);
    expect(result.promptText).toContain('cotización');
  });

  it('respects hardCap', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: `msg-${i}`,
      created_at: new Date(1_000_000 + i * 1000).toISOString(),
      message: 'A'.repeat(10),
      instance_id: 'inst-1',
    }));
    const page2 = Array.from({ length: 100 }, (_, i) => ({
      id: `msg-${100 + i}`,
      created_at: new Date(2_000_000 + i * 1000).toISOString(),
      message: 'B'.repeat(10),
      instance_id: 'inst-1',
    }));

    mockRange
      .mockResolvedValueOnce({ data: page1, error: null })
      .mockResolvedValueOnce({ data: page2, error: null });

    const result = await loadUserActionHistory('inst-1', { hardCap: 150 });
    expect(result.totalCount).toBe(150);
  });
});
