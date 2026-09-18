import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockFrom: any = jest.fn();
const mockRpc: any = jest.fn();
const mockGenerateEmbeddings: any = jest.fn();
const mockSummarizeSource: any = jest.fn();

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: mockFrom,
    rpc: mockRpc,
  },
}));
jest.mock('@/lib/services/embeddings-service', () => ({
  EmbeddingsService: {
    generateEmbeddings: mockGenerateEmbeddings,
  },
}));
jest.mock('@/lib/services/summary/SummaryGenerationService', () => ({
  SummaryGenerationService: {
    summarizeSource: mockSummarizeSource,
  },
}));

import { processRecordEmbeddingsById } from '../record-embedding-worker';

const recordId = '00000000-0000-4000-8000-000000000100';
const nodeId = '00000000-0000-4000-8000-000000000101';

describe('record embedding worker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGenerateEmbeddings.mockResolvedValue({
      embeddings: [Array.from({ length: 1536 }, () => 0.1)],
    });
    mockSummarizeSource.mockResolvedValue({
      success: true,
      summary: 'Current record summary',
    });
  });

  it('requeues stale writes before completing claimed jobs', async () => {
    const recordQuery: any = {
      select: jest.fn(() => recordQuery),
      eq: jest.fn(() => recordQuery),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          id: recordId,
          site_id: '00000000-0000-4000-8000-000000000200',
          title: 'Research',
          record_embedding_revision: 3,
          category: { name: 'Discovery' },
        },
        error: null,
      }),
    };
    const diagramQuery: any = {
      select: jest.fn(() => diagramQuery),
      eq: jest.fn(() => diagramQuery),
      maybeSingle: jest.fn().mockResolvedValue({
        data: { revision: 2 },
        error: null,
      }),
    };
    const nodeQuery: any = {
      select: jest.fn(() => nodeQuery),
      eq: jest.fn(() => nodeQuery),
      in: jest.fn().mockResolvedValue({
        data: [{
          id: nodeId,
          kind: 'concept',
          title: 'Signal',
          content: 'Current content',
          metadata: {},
          embedding_source_hash: 'old-hash',
        }],
        error: null,
      }),
    };
    const jobUpdateQuery: any = {
      update: jest.fn(() => jobUpdateQuery),
      in: jest.fn(() => jobUpdateQuery),
      eq: jest.fn().mockResolvedValue({ error: null }),
    };
    mockRpc.mockImplementation(async (name: string) => {
      if (name === 'claim_record_embedding_jobs') {
        return {
          data: [{
            id: '00000000-0000-4000-8000-000000000300',
            diagram_revision: 1,
            node_ids: [nodeId],
            attempts: 1,
          }],
          error: null,
        };
      }
      if (name === 'save_record_diagram_node_embedding') {
        return { data: false, error: null };
      }
      if (name === 'get_record_diagram_context') {
        return {
          data: {
            record: { title: 'Research', category: 'Discovery' },
            nodes: [],
            edges: [],
          },
          error: null,
        };
      }
      if (name === 'save_record_aggregate_embedding') {
        return { data: false, error: null };
      }
      if (name === 'enqueue_record_embedding_job') {
        return { data: 'job-id', error: null };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });

    mockFrom.mockImplementation((table: string) => {
      if (table === 'records') return recordQuery;
      if (table === 'record_diagrams') return diagramQuery;
      if (table === 'record_diagram_nodes') return nodeQuery;
      if (table === 'record_embedding_jobs') return jobUpdateQuery;
      throw new Error(`Unexpected table: ${table}`);
    });

    const result = await processRecordEmbeddingsById({ recordId });

    expect(result.processedJobs).toBe(1);
    expect(result.processedNodes).toBe(1);
    expect(result.stale).toBe(true);
    expect(mockRpc).toHaveBeenCalledWith(
      'enqueue_record_embedding_job',
      {
        p_record_id: recordId,
        p_node_ids: [nodeId],
        p_replace: true,
      },
    );
    expect(mockRpc).toHaveBeenCalledWith(
      'save_record_diagram_node_embedding',
      expect.objectContaining({
        p_embedding_source_hash: 'old-hash',
        p_record_revision: 3,
        p_new_embedding_source_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
  });
});
