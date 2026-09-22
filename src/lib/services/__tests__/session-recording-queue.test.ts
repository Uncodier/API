import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';

const mockSet: any = jest.fn();
const mockXadd: any = jest.fn();
const mockXrange: any = jest.fn();
const mockXdel: any = jest.fn();
const mockXlen: any = jest.fn();
const mockEval: any = jest.fn();

jest.mock('@/lib/utils/tracking-redis-client', () => ({
  getTrackingRedisClient: () => ({
    set: mockSet,
    xadd: mockXadd,
    xrange: mockXrange,
    xdel: mockXdel,
    xlen: mockXlen,
    eval: mockEval,
  }),
}));
jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {},
}));

import {
  drainRecordingMetadataQueue,
  enqueueRecordingMetadata,
  type RecordingMetadataChunk,
} from '../session-recording-queue';

const originalRedisUrl = process.env.REDIS_URL;

function metadataChunk(index: number): RecordingMetadataChunk {
  return {
    event_id: `event-${index}`,
    site_id: 'site-a',
    visitor_id: null,
    session_id: 'session-a',
    url: null,
    timestamp: index,
    storage_path: `site-a/session-a/${index}.json`,
    chunk_id: `chunk-${index}`,
    content_hash: `hash-${index}`,
    start_timestamp: index,
    end_timestamp: index,
    event_count: 1,
    metadata: {},
  };
}

describe('session recording metadata queue', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.REDIS_URL = 'redis://example.test:6379';
    mockSet.mockResolvedValue('OK');
    mockXadd.mockResolvedValue('1-0');
    mockXdel.mockResolvedValue(1);
    mockXlen.mockResolvedValue(0);
    mockEval.mockResolvedValue(1);
  });

  afterEach(() => {
    if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalRedisUrl;
  });

  it('enqueues only the small metadata manifest', async () => {
    const chunks = [metadataChunk(1)];
    mockEval.mockResolvedValueOnce('1-0');

    await expect(enqueueRecordingMetadata(chunks)).resolves.toBe('1-0');
    expect(mockEval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('XLEN'"),
      1,
      'recording:{metadata}:pending',
      300,
      JSON.stringify(chunks),
    );
  });

  it('drops new metadata when the queue has reached its hard limit', async () => {
    mockEval.mockResolvedValueOnce(0);

    await expect(
      enqueueRecordingMetadata([metadataChunk(1)]),
    ).resolves.toBeNull();
  });

  it('batches queued chunks into at most ten per Supabase RPC', async () => {
    const entries = Array.from({ length: 4 }, (_, messageIndex) => {
      const chunks = Array.from(
        { length: 3 },
        (_, chunkIndex) => metadataChunk(messageIndex * 3 + chunkIndex),
      );
      return [
        `${messageIndex + 1}-0`,
        ['payload', JSON.stringify(chunks)],
      ];
    });
    mockXrange.mockResolvedValue(entries);
    const rpc: any = jest.fn(async () => ({ error: null }));

    const result = await drainRecordingMetadataQueue({ rpc } as never);

    expect(result).toMatchObject({
      state: 'processed',
      messages: 4,
      chunks: 12,
      rpcCalls: 2,
    });
    expect(rpc.mock.calls[0][1].p_chunks).toHaveLength(9);
    expect(rpc.mock.calls[1][1].p_chunks).toHaveLength(3);
    expect(mockXdel).toHaveBeenCalledWith(
      'recording:{metadata}:pending',
      '1-0',
      '2-0',
      '3-0',
      '4-0',
    );
  });

  it('bisects permanent RPC failures and dead-letters only the poison message', async () => {
    const entries = [1, 2, 3].map((index) => [
      `${index}-0`,
      ['payload', JSON.stringify([metadataChunk(index)])],
    ]);
    mockXrange.mockResolvedValue(entries);
    const rpc: any = jest.fn(async (_name: string, args: {
      p_chunks: RecordingMetadataChunk[];
    }) => ({
      error: args.p_chunks.some((chunk) => chunk.chunk_id === 'chunk-2')
        ? { code: 'P0001', message: 'Invalid recording chunk' }
        : null,
    }));

    const result = await drainRecordingMetadataQueue({ rpc } as never);

    expect(result).toMatchObject({
      state: 'processed',
      messages: 3,
      chunks: 2,
      deadLetters: 1,
    });
    expect(mockXadd).toHaveBeenCalledWith(
      'recording:{metadata}:dead-letter',
      'MAXLEN',
      '~',
      1000,
      '*',
      'source_id',
      '2-0',
      'payload',
      JSON.stringify([metadataChunk(2)]),
      'error',
      'Invalid recording chunk',
      'error_code',
      'P0001',
    );
    expect(mockXdel).toHaveBeenCalledWith(
      'recording:{metadata}:pending',
      '2-0',
      '1-0',
      '3-0',
    );
  });

  it('keeps messages queued when the RPC failure is transient', async () => {
    mockXrange.mockResolvedValue([
      ['1-0', ['payload', JSON.stringify([metadataChunk(1)])]],
    ]);
    const rpc: any = jest.fn(async () => ({
      error: { code: '57014', message: 'statement timeout' },
    }));

    await expect(
      drainRecordingMetadataQueue({ rpc } as never),
    ).rejects.toThrow('statement timeout');
    expect(mockXadd).not.toHaveBeenCalled();
    expect(mockXdel).not.toHaveBeenCalled();
  });
});
