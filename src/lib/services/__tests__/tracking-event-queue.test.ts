import {
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';

const mockSet: any = jest.fn();
const mockXadd: any = jest.fn();
const mockXgroup: any = jest.fn();
const mockXautoclaim: any = jest.fn();
const mockXreadgroup: any = jest.fn();
const mockXlen: any = jest.fn();
const mockEval: any = jest.fn();

jest.mock('@/lib/utils/tracking-redis-client', () => ({
  getTrackingRedisClient: () => ({
    set: mockSet,
    xadd: mockXadd,
    xgroup: mockXgroup,
    xautoclaim: mockXautoclaim,
    xreadgroup: mockXreadgroup,
    xlen: mockXlen,
    eval: mockEval,
  }),
}));
jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {},
}));

import {
  drainTrackingEventQueue,
  enqueueTrackingEvents,
} from '../tracking-event-queue';
import type { QueuedTrackingEvent } from '../tracking-event-ingest';

function event(id: string): QueuedTrackingEvent {
  return {
    id,
    site_id: '33333333-3333-4333-8333-333333333333',
    event_type: 'pageview',
    event_name: null,
    url: 'https://example.com/',
    referrer: null,
    visitor_id: null,
    session_id: null,
    segment_id: null,
    timestamp: 1,
    properties: {},
    user_agent: null,
    ip: null,
    data: {},
  };
}

function streamEntry(id: string, events: QueuedTrackingEvent[]) {
  return [
    id,
    ['payload', JSON.stringify({ version: 1, events })],
  ];
}

describe('tracking event queue', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSet.mockResolvedValue('OK');
    mockXadd.mockResolvedValue('1-0');
    mockXgroup.mockResolvedValue('OK');
    mockXautoclaim.mockResolvedValue(['0-0', []]);
    mockXreadgroup.mockResolvedValue(null);
    mockXlen.mockResolvedValue(0);
    mockEval.mockResolvedValue(1);
  });

  it('durably enqueues events without trimming the stream', async () => {
    const events = [event('11111111-1111-4111-8111-111111111111')];
    mockEval.mockResolvedValueOnce('1-0');

    await expect(enqueueTrackingEvents(events)).resolves.toBe('1-0');
    expect(mockEval).toHaveBeenCalledWith(
      expect.stringContaining("'XLEN'"),
      1,
      'tracking:{events}:pending',
      100_000,
      JSON.stringify({ version: 1, events }),
    );
    expect(mockXadd).not.toHaveBeenCalled();
  });

  it('rejects an enqueue when the atomic queue limit is reached', async () => {
    mockEval.mockResolvedValueOnce(null);

    await expect(enqueueTrackingEvents([
      event('11111111-1111-4111-8111-111111111111'),
    ])).rejects.toThrow('Tracking queue backlog limit reached');
  });

  it('persists and atomically acknowledges a claimed message', async () => {
    const queuedEvent = event('11111111-1111-4111-8111-111111111111');
    mockXautoclaim.mockResolvedValue([
      '0-0',
      [streamEntry('1-0', [queuedEvent])],
    ]);
    const rpc: any = jest.fn(async () => ({ error: null }));

    await expect(
      drainTrackingEventQueue({ rpc } as never),
    ).resolves.toMatchObject({
      state: 'processed',
      messages: 1,
      events: 1,
      deadLetters: 0,
    });
    expect(rpc).toHaveBeenCalledWith('persist_tracking_event_batch', {
      p_events: [queuedEvent],
    });
    expect(mockEval).toHaveBeenCalledWith(
      expect.stringContaining("'XACK'"),
      1,
      'tracking:{events}:pending',
      'tracking-database',
      '1-0',
    );
  });

  it('combines small stream messages into one database batch', async () => {
    const first = event('11111111-1111-4111-8111-111111111111');
    const second = event('22222222-2222-4222-8222-222222222222');
    mockXautoclaim.mockResolvedValue([
      '0-0',
      [
        streamEntry('1-0', [first]),
        streamEntry('2-0', [second]),
      ],
    ]);
    const rpc: any = jest.fn(async () => ({ error: null }));

    await drainTrackingEventQueue({ rpc } as never);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('persist_tracking_event_batch', {
      p_events: [first, second],
    });
    expect(mockEval).toHaveBeenCalledWith(
      expect.stringContaining("'XACK'"),
      1,
      'tracking:{events}:pending',
      'tracking-database',
      '1-0',
      '2-0',
    );
  });

  it('leaves the message pending after a transient database error', async () => {
    mockXautoclaim.mockResolvedValue([
      '0-0',
      [streamEntry(
        '1-0',
        [event('11111111-1111-4111-8111-111111111111')],
      )],
    ]);
    const rpc: any = jest.fn(async () => ({
      error: { code: '57014', message: 'statement timeout' },
    }));

    await expect(
      drainTrackingEventQueue({ rpc } as never),
    ).rejects.toThrow('statement timeout');
    expect(mockEval).not.toHaveBeenCalledWith(
      expect.stringContaining("'XACK'"),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('moves permanently invalid events to the dead-letter stream', async () => {
    mockXautoclaim.mockResolvedValue([
      '0-0',
      [streamEntry(
        '1-0',
        [event('11111111-1111-4111-8111-111111111111')],
      )],
    ]);
    const rpc: any = jest.fn(async () => ({
      error: { code: '23503', message: 'foreign key violation' },
    }));

    await expect(
      drainTrackingEventQueue({ rpc } as never),
    ).resolves.toMatchObject({
      events: 0,
      deadLetters: 1,
    });
    expect(mockEval).toHaveBeenCalledWith(
      expect.stringContaining("'XADD'"),
      2,
      'tracking:{events}:pending',
      'tracking:{events}:dead-letter',
      'tracking-database',
      '1-0',
      expect.any(String),
      'foreign key violation',
      '23503',
    );
  });
});
