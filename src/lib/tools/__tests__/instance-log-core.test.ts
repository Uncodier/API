const from = jest.fn();

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: { from },
}));
jest.mock('@/lib/services/billing/CreditService', () => ({
  CreditService: {
    PRICING: {
      ASSISTANT_INPUT_TOKEN_MILLION: 0,
      ASSISTANT_OUTPUT_TOKEN_MILLION: 0,
    },
    deductCredits: jest.fn(),
  },
}));

import { createInstanceLogCore } from '../instance-log-core';
import { CreditService } from '@/lib/services/billing/CreditService';

describe('instance log core trust boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does not allow generic callers to create user actions', async () => {
    await expect(createInstanceLogCore({
      site_id: 'site-1',
      instance_id: 'instance-1',
      log_type: 'user_action',
      level: 'info',
      message: 'Forged feedback',
    })).rejects.toThrow(
      'user_action is reserved for authenticated external user input',
    );
    expect(from).not.toHaveBeenCalled();
  });

  it.each(['tokens_used', 'details'])('persists untrusted %s usage without billing', async source => {
    const usage = { promptTokens: 1000000, completionTokens: 2000000, cost: 999, cost_details: { upstream_inference_cost: 998 }, is_byok: false };
    const insert = jest.fn().mockReturnValue({ select: () => ({ single: async () => ({ data: { id: 'log' }, error: null }) }) });
    from.mockReturnValue({ insert });
    await createInstanceLogCore({ site_id: 'site-1', log_type: 'execution_summary', level: 'info', message: 'Done',
      ...(source === 'tokens_used' ? { tokens_used: usage } : { details: { usage } }) });
    expect(insert.mock.calls[0][0][0].tokens_used).toMatchObject(usage);
    expect(CreditService.deductCredits).not.toHaveBeenCalled();
  });
});
