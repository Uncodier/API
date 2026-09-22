import { supabaseAdmin } from '@/lib/database/supabase-client';
import { manageLeadCreation } from '../lead-service';

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn(),
  },
}));

describe('manageLeadCreation social identity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('finds and persists social identity using lead metadata', async () => {
    const lookupQuery: any = {
      select: jest.fn(),
      eq: jest.fn(),
      or: jest.fn(),
      limit: jest.fn(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: { id: 'existing-lead-id' },
        error: null,
      }),
    };
    lookupQuery.select.mockReturnValue(lookupQuery);
    lookupQuery.eq.mockReturnValue(lookupQuery);
    lookupQuery.or.mockReturnValue(lookupQuery);
    lookupQuery.limit.mockReturnValue(lookupQuery);

    const currentLeadQuery: any = {
      select: jest.fn(),
      eq: jest.fn(),
      single: jest.fn().mockResolvedValue({
        data: {
          metadata: { existing_key: 'existing-value' },
          social_networks: {},
        },
        error: null,
      }),
    };
    currentLeadQuery.select.mockReturnValue(currentLeadQuery);
    currentLeadQuery.eq.mockReturnValue(currentLeadQuery);

    const updateEq = jest.fn().mockResolvedValue({ error: null });
    const updateQuery = {
      update: jest.fn().mockReturnValue({ eq: updateEq }),
    };

    (supabaseAdmin.from as jest.Mock)
      .mockReturnValueOnce(lookupQuery)
      .mockReturnValueOnce(currentLeadQuery)
      .mockReturnValueOnce(updateQuery);

    const result = await manageLeadCreation({
      siteId: 'site-id',
      origin: 'instagram',
      socialHandle: 'alice',
    });

    expect(lookupQuery.or).toHaveBeenCalledWith(
      'metadata->>social_handle.eq."alice",social_networks->>instagram.eq."alice"',
    );
    expect(currentLeadQuery.select).toHaveBeenCalledWith('social_networks, metadata');
    expect(updateQuery.update).toHaveBeenCalledWith({
      metadata: {
        existing_key: 'existing-value',
        social_handle: 'alice',
        social_network: 'instagram',
      },
      social_networks: {
        instagram: 'alice',
      },
    });
    expect(updateEq).toHaveBeenCalledWith('id', 'existing-lead-id');
    expect(result).toEqual({
      leadId: 'existing-lead-id',
      isNewLead: false,
      taskId: null,
    });
  });
});
