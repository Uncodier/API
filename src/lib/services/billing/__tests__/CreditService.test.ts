const mockRpc = jest.fn();
const mockSingle = jest.fn();
const mockFrom = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: { rpc: (...args: unknown[]) => mockRpc(...args), from: (...args: unknown[]) => mockFrom(...args) },
}));
jest.mock('@/lib/services/sendgrid-service', () => ({ sendGridService: {} }));
jest.mock('@/lib/i18n/email-locale', () => ({ resolveEmailLocale: jest.fn() }));
jest.mock('@/lib/i18n/email-messages/platform', () => ({ platformT: jest.fn() }));
jest.mock('@/lib/services/email/EmailSendService', () => ({ EmailSendService: {} }));

import { CreditService } from '../CreditService';

describe('CreditService classified balance checks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const query = { select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), single: mockSingle };
    mockFrom.mockReturnValue(query);
    mockRpc.mockResolvedValue({ data: { success: true, outcome: 'not_due' }, error: null });
    mockSingle.mockResolvedValue({ data: { credits_available: 10 }, error: null });
  });

  it('refreshes the included period before reading usable credits', async () => {
    expect(await CreditService.validateCredits('synthetic-site', 3)).toBe(true);
    expect(mockRpc).toHaveBeenCalledWith('renew_site_plan_credits', { p_site_id: 'synthetic-site' });
    expect(mockRpc.mock.invocationCallOrder[0]).toBeLessThan(mockFrom.mock.invocationCallOrder[0]);
  });

  it.each([
    { data: null, error: { message: 'Unavailable' } },
    { data: { success: false }, error: null },
  ])('does not spend stale balance when renewal fails', async result => {
    mockRpc.mockResolvedValue(result);
    expect(await CreditService.validateCredits('synthetic-site', 3)).toBe(false);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it.each([NaN, Infinity, -1])('rejects invalid required credits %s before database calls', async amount => {
    expect(await CreditService.validateCredits('synthetic-site', amount)).toBe(false);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it.each([NaN, Infinity, -1, 0])('rejects invalid deductions %s before database calls', async amount => {
    expect(await CreditService.deductCredits('synthetic-site', amount, 'usage', 'Synthetic usage')).toEqual({
      success: false, error: 'Invalid siteId or amount',
    });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('keeps the secure deduction contract and accepts the bucket-aware response', async () => {
    mockRpc.mockResolvedValue({ data: { success: true, remaining: 7 }, error: null });
    expect(await CreditService.deductCredits('synthetic-site', 3, 'usage', 'Synthetic usage')).toEqual({ success: true, remaining: 7 });
    expect(mockRpc).toHaveBeenCalledWith('deduct_credits', {
      p_site_id: 'synthetic-site', p_amount: 3, p_type: 'usage', p_description: 'Synthetic usage', p_metadata: {},
    });
  });

  it('returns a structured error for an empty RPC response', async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    expect(await CreditService.deductCredits('synthetic-site', 3, 'usage', 'Synthetic')).toEqual({
      success: false, error: 'Invalid credit deduction response',
    });
  });
});