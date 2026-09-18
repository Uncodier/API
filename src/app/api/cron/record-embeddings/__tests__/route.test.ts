import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockFrom: any = jest.fn();
const mockProcessRecordEmbeddingsById: any = jest.fn();

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: mockFrom,
  },
}));
jest.mock('@/lib/services/record-embedding-worker', () => ({
  processRecordEmbeddingsById: mockProcessRecordEmbeddingsById,
}));

import { GET } from '../route';

describe('record embedding cron', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CRON_SECRET = 'test-secret';
  });

  it('rejects requests when the cron secret is missing', async () => {
    delete process.env.CRON_SECRET;

    const response = await GET(new Request(
      'http://localhost/api/cron/record-embeddings',
      { headers: { authorization: 'Bearer undefined' } },
    ));

    expect(response.status).toBe(401);
    expect(mockProcessRecordEmbeddingsById).not.toHaveBeenCalled();
  });

  it('processes pending records for an authenticated cron request', async () => {
    const jobsQuery: any = {
      select: jest.fn(() => jobsQuery),
      in: jest.fn(() => jobsQuery),
      lt: jest.fn(() => jobsQuery),
      order: jest.fn(() => jobsQuery),
      limit: jest.fn().mockResolvedValue({
        data: [{
          record_id: '00000000-0000-4000-8000-000000000100',
          status: 'pending',
          claimed_at: null,
        }],
        error: null,
      }),
    };
    mockFrom.mockReturnValue(jobsQuery);
    mockProcessRecordEmbeddingsById.mockResolvedValue({
      processedJobs: 1,
      processedNodes: 0,
      remainingNodes: 0,
      stale: false,
    });

    const response = await GET(new Request(
      'http://localhost/api/cron/record-embeddings',
      { headers: { authorization: 'Bearer test-secret' } },
    ));

    expect(mockFrom).toHaveBeenCalledWith('record_embedding_jobs');
    expect(jobsQuery.limit).toHaveBeenCalledWith(100);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      processed: 1,
      failed: [],
    });
    expect(mockProcessRecordEmbeddingsById).toHaveBeenCalledWith({
      recordId: '00000000-0000-4000-8000-000000000100',
    });
  });
});
