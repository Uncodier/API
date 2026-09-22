import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockRpc: any = jest.fn();

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    rpc: mockRpc,
  },
}));

jest.mock('@/lib/services/email/SentEmailDuplicationService', () => ({
  SentEmailDuplicationService: {
    generateEnvelopeBasedId: jest.fn(),
  },
}));

import { SyncedObjectsService } from '../SyncedObjectsService';

describe('SyncedObjectsService batch claims', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('classifies a batch with one database round trip', async () => {
    mockRpc.mockResolvedValue({
      data: [
        {
          external_id: '<new@example.test>',
          status: 'processing',
          claimed_token: 'claim-1',
        },
      ],
      error: null,
    });

    const result = await SyncedObjectsService.filterUnprocessedEmails([
      { messageId: '<processed@example.test>', subject: 'Old' },
      { messageId: '<new@example.test>', subject: 'New' },
    ], '00000000-0000-4000-8000-000000000001');

    expect(result.alreadyProcessed).toHaveLength(1);
    expect(result.unprocessed).toHaveLength(1);
    expect(result.unprocessed[0]._sync_claim_token).toBe('claim-1');
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it('does not process emails when the atomic claim is unavailable', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'database unavailable' },
    });

    await expect(SyncedObjectsService.filterUnprocessedEmails([
      { messageId: '<new@example.test>', subject: 'New' },
    ], '00000000-0000-4000-8000-000000000001')).rejects.toThrow(
      'Batch claim failed: database unavailable',
    );
  });
});
