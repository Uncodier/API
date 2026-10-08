const mockRpc = jest.fn();
const mockSingle = jest.fn();
const mockFrom = jest.fn();
const mockSelect = jest.fn();
const mockEq = jest.fn();
const mockSendEmail = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: { rpc: (...args: unknown[]) => mockRpc(...args), from: (...args: unknown[]) => mockFrom(...args) },
}));
jest.mock('@/lib/services/sendgrid-service', () => ({
  sendGridService: { sendEmail: (...args: unknown[]) => mockSendEmail(...args) },
}));
jest.mock('@/lib/i18n/email-locale', () => ({ resolveEmailLocale: jest.fn() }));
jest.mock('@/lib/i18n/email-messages/platform', () => ({ platformT: jest.fn() }));
jest.mock('@/lib/services/email/EmailSendService', () => ({ EmailSendService: {} }));

import { CreditService, InsufficientCreditsError } from '../CreditService';
import { formatCreditExhaustionNotice, isInsufficientCreditsError } from '../credit-exhaustion-message';

const notifier = CreditService as unknown as {
  notifyInsufficientCredits(siteId: string, required: number, available: number): Promise<void>;
};

describe('CreditService classified balance checks', () => {
  let notification: jest.SpyInstance;
  beforeEach(() => {
    jest.resetAllMocks();
    notification = jest.spyOn(notifier, 'notifyInsufficientCredits').mockResolvedValue(undefined);
    const query = { select: mockSelect.mockReturnThis(), eq: mockEq.mockReturnThis(), single: mockSingle };
    mockFrom.mockReturnValue(query);
    mockRpc.mockResolvedValue({ data: { success: true, outcome: 'not_due' }, error: null });
    mockSingle.mockResolvedValue({ data: { credits_available: 10 }, error: null });
  });
  afterEach(() => jest.restoreAllMocks());

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

  it('requireCredits resolves void after renewing and reading only the aggregate balance', async () => {
    await expect(CreditService.requireCredits('synthetic-site', 3)).resolves.toBeUndefined();
    expect(mockRpc).toHaveBeenCalledWith('renew_site_plan_credits', { p_site_id: 'synthetic-site' });
    expect(mockRpc.mock.invocationCallOrder[0]).toBeLessThan(mockFrom.mock.invocationCallOrder[0]);
    expect(mockFrom).toHaveBeenCalledWith('billing');
    expect(mockSelect).toHaveBeenCalledWith('credits_available');
    expect(mockEq).toHaveBeenCalledWith('site_id', 'synthetic-site');
    expect(notification).not.toHaveBeenCalled();
  });

  it.each([0, 0.001, 10])('accepts valid requirements %s including zero and an exact balance', async required => {
    await expect(CreditService.requireCredits('synthetic-site', required)).resolves.toBeUndefined();
    expect(notification).not.toHaveBeenCalled();
  });

  it.each([NaN, Infinity, -Infinity, -1, null, undefined, '1', {}, true])(
    'requireCredits rejects invalid runtime requirement %s without I/O', async required => {
      const error = await CreditService.requireCredits('synthetic-site', required as number).catch(e => e);
      expect(error.constructor).toBe(Error);
      expect(isInsufficientCreditsError(error)).toBe(false);
      expect(await CreditService.validateCredits('synthetic-site', required as number)).toBe(false);
      expect(mockRpc).not.toHaveBeenCalled();
      expect(mockFrom).not.toHaveBeenCalled();
      expect(notification).not.toHaveBeenCalled();
    },
  );

  it.each(['', '   ', null, undefined, 123])('rejects invalid site %s without I/O', async site => {
    await expect(CreditService.requireCredits(site as string, 1)).rejects.toThrow(Error);
    expect(await CreditService.validateCredits(site as string, 1)).toBe(false);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(notification).not.toHaveBeenCalled();
  });

  it.each([
    { data: null, error: { message: 'Insufficient credits (provider outage)' } },
    { data: null, error: null },
    { data: { success: false }, error: null },
    { data: { success: 'true' }, error: null },
    { data: {}, error: null },
  ])('renewal failures are ordinary Errors, never shortages: %j', async result => {
    mockRpc.mockResolvedValue(result);
    const error = await CreditService.requireCredits('synthetic-site', 3).catch(e => e);
    expect(error.constructor).toBe(Error);
    expect(isInsufficientCreditsError(error)).toBe(false);
    expect(await CreditService.validateCredits('synthetic-site', 3)).toBe(false);
    expect(mockFrom).not.toHaveBeenCalled();
    expect(notification).not.toHaveBeenCalled();
  });

  it.each(['rpc', 'read'])('normalizes rejected %s calls and keeps validateCredits boolean', async operation => {
    // Even a mislabeled provider exception cannot confirm the actual balance.
    const outage = new InsufficientCreditsError('Synthetic provider failure');
    if (operation === 'rpc') mockRpc.mockRejectedValue(outage);
    else mockSingle.mockRejectedValue(outage);
    const error = await CreditService.requireCredits('synthetic-site', 3).catch(e => e);
    expect(error.constructor).toBe(Error);
    expect(isInsufficientCreditsError(error)).toBe(false);
    expect(await CreditService.validateCredits('synthetic-site', 3)).toBe(false);
    expect(notification).not.toHaveBeenCalled();
  });

  it.each([
    { data: null, error: null },
    { data: null, error: { message: 'Unavailable' } },
    { data: { credits_available: 0 }, error: { message: 'Unavailable' } },
  ])('billing outages do not masquerade as zero credits: %j', async result => {
    mockSingle.mockResolvedValue(result);
    const error = await CreditService.requireCredits('synthetic-site', 1).catch(e => e);
    expect(error.constructor).toBe(Error);
    expect(isInsufficientCreditsError(error)).toBe(false);
    expect(await CreditService.validateCredits('synthetic-site', 1)).toBe(false);
    expect(notification).not.toHaveBeenCalled();
  });

  it.each([NaN, Infinity, -Infinity, -1, null, undefined, '0', '10', {}, [], false])(
    'rejects invalid runtime balance %s, including when required is zero', async balance => {
      mockSingle.mockResolvedValue({ data: { credits_available: balance }, error: null });
      const error = await CreditService.requireCredits('synthetic-site', 0).catch(e => e);
      expect(error.constructor).toBe(Error);
      expect(isInsufficientCreditsError(error)).toBe(false);
      expect(await CreditService.validateCredits('synthetic-site', 1)).toBe(false);
      expect(notification).not.toHaveBeenCalled();
    },
  );

  it.each([0, 0.25])('only confirmed shortage %s uses the typed error and notification path', async balance => {
    mockSingle.mockResolvedValue({ data: { credits_available: balance }, error: null });
    const error = await CreditService.requireCredits('synthetic-site', 1).catch(e => e);
    expect(error).toBeInstanceOf(InsufficientCreditsError);
    expect(error.message).toBe(`Not enough credits. Available: ${balance}, Required: 1`);
    expect(isInsufficientCreditsError(error)).toBe(true);
    expect(notification).toHaveBeenCalledTimes(1);
    expect(notification).toHaveBeenCalledWith('synthetic-site', 1, balance);
    expect(await CreditService.validateCredits('synthetic-site', 1)).toBe(false);
    expect(notification).toHaveBeenCalledTimes(2); // One notification attempt per check, same debounce inside.
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('validateCredits delegates and catches any exception', async () => {
    const require = jest.spyOn(CreditService, 'requireCredits').mockRejectedValue('Synthetic thrown value');
    expect(await CreditService.validateCredits('synthetic-site', 3)).toBe(false);
    expect(require).toHaveBeenCalledWith('synthetic-site', 3);
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

describe('CreditService read-only exhaustion notices', () => {
  const now = new Date('2030-10-15T12:00:00Z');
  const billing = {
    credits_available: 0.25, status: 'active', plan_credit_period_end: '2030-11-01T00:00:00Z',
    plan_credit_allowance: 20, stripe_subscription_id: null, subscription_status: null,
  };
  beforeEach(() => {
    jest.resetAllMocks();
    jest.useFakeTimers().setSystemTime(now);
    mockFrom.mockReturnValue({ select: mockSelect.mockReturnThis(), eq: mockEq.mockReturnThis(), single: mockSingle });
    mockSingle.mockResolvedValue({ data: billing, error: null });
  });
  afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

  it('reads only notice fields including annual coverage without renewing, notifying or writing', async () => {
    const notice = await CreditService.getCreditExhaustionNotice('synthetic-site');
    expect(notice).toEqual(formatCreditExhaustionNotice(billing, now));
    expect(notice.available).toBe(0.25);
    expect(notice.nextResetAt).toBe('2030-11-01T00:00:00.000Z');
    expect(mockFrom.mock.calls).toEqual([['billing']]);
    expect(mockSelect).toHaveBeenCalledWith('credits_available,status,plan_credit_period_end,plan_credit_allowance,stripe_subscription_id,subscription_status,billing_interval,paid_subscription_period_end');
    expect(mockEq).toHaveBeenCalledWith('site_id', 'synthetic-site');
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it.each([
    { plan_credit_period_end: null }, { plan_credit_period_end: 'invalid' },
    { plan_credit_period_end: '2030-10-01T00:00:00Z' }, { status: 'inactive' },
    { plan_credit_allowance: 0 }, { stripe_subscription_id: 'synthetic-subscription', subscription_status: 'past_due' },
  ])('suppresses unconfirmed next reset: %j', async overrides => {
    mockSingle.mockResolvedValue({ data: { ...billing, ...overrides }, error: null });
    const notice = await CreditService.getCreditExhaustionNotice('synthetic-site');
    expect(notice.nextResetAt).toBeNull();
    expect(notice.available).toBe(0.25);
    expect(notice.message).toContain('No hay una fecha de renovación confirmada.');
  });

  it('makes a future Stripe renewal explicitly conditional on payment', async () => {
    mockSingle.mockResolvedValue({ data: {
      ...billing, stripe_subscription_id: 'synthetic-subscription', subscription_status: 'active',
    }, error: null });
    const notice = await CreditService.getCreditExhaustionNotice('synthetic-site');
    expect(notice.nextResetAt).toBe('2030-11-01T00:00:00.000Z');
    expect(notice.message).toContain('siempre que se confirme el pago de renovación');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it.each([
    { data: null, error: null }, { data: billing, error: { message: 'Unavailable' } },
    { data: {}, error: null },
  ])('unavailable billing returns unknown, not fabricated zero: %j', async result => {
    mockSingle.mockResolvedValue(result);
    expect(await CreditService.getCreditExhaustionNotice('synthetic-site')).toEqual(formatCreditExhaustionNotice(null, now));
  });

  it('handles rejected reads as unknown without leaking provider text', async () => {
    mockSingle.mockRejectedValue(new Error('Synthetic provider failure'));
    expect(await CreditService.getCreditExhaustionNotice('synthetic-site')).toEqual(formatCreditExhaustionNotice(null, now));
  });

  it.each(['', '   ', null, undefined, 123])('does not query an invalid site %s', async site => {
    expect(await CreditService.getCreditExhaustionNotice(site as string)).toEqual(formatCreditExhaustionNotice(null, now));
    expect(mockFrom).not.toHaveBeenCalled();
  });
});

describe('CreditService shortage notification debounce (offline)', () => {
  afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

  it('uses the existing 24-hour debounce and sends no email when already notified', async () => {
    jest.resetAllMocks();
    jest.useFakeTimers().setSystemTime(new Date('2030-10-15T12:00:00Z'));
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const gte = jest.fn().mockReturnThis();
    const notificationQuery = {
      select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), gte,
      limit: jest.fn().mockResolvedValue({ data: [{ id: 'synthetic-notification' }], error: null }),
    };
    const balanceQuery = {
      select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data: { credits_available: 0 }, error: null }),
    };
    mockFrom.mockImplementation(table => {
      if (table === 'billing') return balanceQuery;
      if (table === 'notifications') return notificationQuery;
      throw new Error('Unexpected offline query');
    });
    mockRpc.mockResolvedValue({ data: { success: true }, error: null });
    await expect(CreditService.requireCredits('synthetic-site', 1)).rejects.toBeInstanceOf(InsufficientCreditsError);
    expect(await CreditService.validateCredits('synthetic-site', 1)).toBe(false);
    expect(notificationQuery.limit).toHaveBeenCalledTimes(2);
    expect(notificationQuery.eq).toHaveBeenCalledWith('title', 'Insufficient Credits');
    expect(notificationQuery.eq).toHaveBeenCalledWith('type', 'error');
    expect(gte).toHaveBeenCalledWith('created_at', '2030-10-14T12:00:00.000Z');
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockFrom.mock.calls.every(([table]) => table === 'billing' || table === 'notifications')).toBe(true);
  });
});