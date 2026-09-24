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
});
