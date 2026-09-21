import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockFrom: any = jest.fn();
const mockFetchNodeContexts: any = jest.fn();

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: { from: mockFrom },
}));
jest.mock('@/lib/services/robot-instance/assistant-logging', () => ({
  fetchNodeContexts: mockFetchNodeContexts,
}));

import { resolveUiMediaContract } from '../ui-media-contract';

const instanceId = '11111111-1111-4111-8111-111111111111';
const siteId = '22222222-2222-4222-8222-222222222222';

function nodeQuery(result: { data: unknown; error: unknown }) {
  const query: any = {};
  query.select = jest.fn(() => query);
  query.eq = jest.fn(() => query);
  query.maybeSingle = jest.fn(async () => result);
  return query;
}

describe('resolveUiMediaContract scope', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchNodeContexts.mockResolvedValue([]);
  });

  it('scopes the node and its references to the requested site and instance', async () => {
    const query = nodeQuery({
      data: {
        id: 'node-1',
        instance_id: instanceId,
        site_id: siteId,
        type: 'generate-image',
        settings: {},
        parent_node_id: null,
      },
      error: null,
    });
    mockFrom.mockReturnValue(query);

    await resolveUiMediaContract({
      instanceNodeId: 'node-1',
      instanceId,
      siteId,
    });

    expect(query.eq).toHaveBeenCalledWith('id', 'node-1');
    expect(query.eq).toHaveBeenCalledWith('instance_id', instanceId);
    expect(query.eq).toHaveBeenCalledWith('site_id', siteId);
    expect(mockFetchNodeContexts).toHaveBeenCalledWith('node-1', {
      instanceId,
      siteId,
    });
  });

  it('fails closed when the node is outside the requested scope', async () => {
    mockFrom.mockReturnValue(nodeQuery({ data: null, error: null }));

    await expect(resolveUiMediaContract({
      instanceNodeId: 'foreign-node',
      instanceId,
      siteId,
    })).rejects.toThrow('UI node does not belong');
  });
});
