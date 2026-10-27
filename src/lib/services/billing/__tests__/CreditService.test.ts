import { createHash, randomUUID } from 'node:crypto';

const mockRpc = jest.fn();
const mockSingle = jest.fn();
const mockFrom = jest.fn();
const mockSelect = jest.fn();
const mockEq = jest.fn();
const mockSendEmail = jest.fn();
const mockGetUserById = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    rpc: (...args: unknown[]) => mockRpc(...args), from: (...args: unknown[]) => mockFrom(...args),
    auth: { admin: { getUserById: (...args: unknown[]) => mockGetUserById(...args) } },
  },
}));
jest.mock('@/lib/services/sendgrid-service', () => ({
  sendGridService: { sendEmail: (...args: unknown[]) => mockSendEmail(...args) },
}));
jest.mock('@/lib/i18n/email-locale', () => ({ resolveEmailLocale: jest.fn() }));
jest.mock('@/lib/i18n/email-messages/platform', () => ({ platformT: jest.fn() }));
jest.mock('@/lib/services/email/EmailSendService', () => ({
  EmailSendService: { escapeHtml: (value: string) => value, escapeAttr: (value: string) => value },
}));

import { CreditService, InsufficientCreditsError } from '../CreditService';
import { formatCreditExhaustionNotice, isInsufficientCreditsError } from '../credit-exhaustion-message';
import { resolveEmailLocale } from '@/lib/i18n/email-locale';
import { platformT } from '@/lib/i18n/email-messages/platform';
import { withRequirementChargeContext } from '../requirement-charge-context';

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

  it('attributes one existing tool debit to the host requirement without a second charge', async () => {
    const context = { siteId: randomUUID(), requirementId: randomUUID(), sessionId: randomUUID() };
    await withRequirementChargeContext(context, () => CreditService.deductCredits(context.siteId, 0.1,
      'web_search', 'Synthetic search', { requirement_id: randomUUID() }));
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith('deduct_credits', expect.objectContaining({ p_amount: 0.1,
      p_metadata: { requirement_id: context.requirementId, session_id: context.sessionId } }));
    mockRpc.mockClear();
    await expect(withRequirementChargeContext(context, () => CreditService.deductCredits(randomUUID(), 0.1,
      'web_search', 'Synthetic mismatch'))).rejects.toThrow('tenant mismatch');
    expect(mockRpc).not.toHaveBeenCalled();
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

describe('CreditService insufficient-credit email admission (offline)', () => {
  let siteQuery: { select: jest.Mock; eq: jest.Mock; single: jest.Mock };
  let notificationQuery: { select: jest.Mock; eq: jest.Mock; gte: jest.Mock; limit: jest.Mock; insert: jest.Mock };
  let reservations: Map<string, string>;
  const siteId = 'synthetic-site';
  const ownerEmail = 'owner@example.invalid';

  beforeEach(() => {
    jest.resetAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    reservations = new Map();
    siteQuery = {
      select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data: { name: 'Synthetic site', user_id: 'synthetic-owner' }, error: null }),
    };
    notificationQuery = {
      select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), gte: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue({ data: [], error: null }),
      insert: jest.fn().mockResolvedValue({ error: null }),
    };
    mockFrom.mockImplementation(table => {
      if (table === 'sites') return siteQuery;
      if (table === 'notifications') return notificationQuery;
      throw new Error('Unexpected offline table');
    });
    mockGetUserById.mockResolvedValue({ data: { user: { email: ownerEmail, user_metadata: { name: 'Synthetic owner' } } }, error: null });
    (resolveEmailLocale as jest.Mock).mockResolvedValue('es');
    (platformT as jest.Mock).mockImplementation((_locale, key) => key);
    // Emulate the atomic RPC contract, not PostgreSQL locking. The SQL runner
    // independently executes the migration and verifies its rolling gates.
    mockRpc.mockImplementation(async (name, params) => {
      if (name !== 'claim_insufficient_credit_email') throw new Error('Unexpected offline RPC');
      if (reservations.has(params.p_site_id)) return { data: { acquired: false, reason: 'site_rate_limited' }, error: null };
      const idempotencyKey = randomUUID();
      reservations.set(params.p_site_id, idempotencyKey);
      return { data: { acquired: true, idempotency_key: idempotencyKey }, error: null };
    });
    mockSendEmail.mockResolvedValue({ success: true });
  });

  afterEach(() => jest.restoreAllMocks());

  it('reserves before dispatch, hashes the normalized recipient and passes the operation key', async () => {
    mockGetUserById.mockResolvedValue({ data: { user: { email: '  Owner@Example.Invalid  ' } }, error: null });
    await notifier.notifyInsufficientCredits(siteId, 0.1, 0);
    expect(mockRpc).toHaveBeenCalledWith('claim_insufficient_credit_email', {
      p_site_id: siteId, p_recipient_hash: createHash('sha256').update(ownerEmail).digest('hex'),
      p_owner_id: 'synthetic-owner',
    });
    expect(JSON.stringify(mockRpc.mock.calls)).not.toContain(ownerEmail);
    expect(mockRpc.mock.invocationCallOrder[0]).toBeLessThan(mockSendEmail.mock.invocationCallOrder[0]);
    expect(mockSendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: ownerEmail, idempotencyKey: reservations.get(siteId),
      categories: ['billing', 'system-notification', 'insufficient-credits'],
      customArgs: { siteId, notificationType: 'insufficient_credits', locale: 'es' },
    }));
    expect(notificationQuery.insert).toHaveBeenCalledTimes(1);
    expect(JSON.stringify((console.log as jest.Mock).mock.calls)).not.toContain(ownerEmail);
  });

  it('dispatches once for 30 simultaneous attempts even with different required amounts', async () => {
    await Promise.all(Array.from({ length: 30 }, (_, i) => notifier.notifyInsufficientCredits(siteId, 0.1 + i, 0)));
    expect(mockRpc).toHaveBeenCalledTimes(30);
    expect(reservations.size).toBe(1);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(notificationQuery.insert).toHaveBeenCalledTimes(1);
  });

  it.each(['site_rate_limited', 'recipient_rate_limited', 'site_unavailable'])('does not dispatch or insert when denied by %s', async reason => {
    mockRpc.mockResolvedValue({ data: { acquired: false, reason }, error: null });
    await notifier.notifyInsufficientCredits(siteId, 1, 0);
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(notificationQuery.insert).not.toHaveBeenCalled();
  });

  it.each([
    { data: null, error: { message: 'Unavailable' } },
    { data: { acquired: true, idempotency_key: randomUUID() }, error: { message: 'Unavailable' } },
    { data: null, error: null },
    { data: {}, error: null },
    { data: { acquired: 'true', idempotency_key: randomUUID() }, error: null },
    { data: { acquired: true }, error: null },
    { data: { acquired: true, idempotency_key: '' }, error: null },
    { data: { acquired: true, idempotency_key: '  ' }, error: null },
    { data: { acquired: true, idempotency_key: 123 }, error: null },
  ])('fails closed for an unavailable or malformed admission response: %j', async response => {
    mockRpc.mockResolvedValue(response);
    await notifier.notifyInsufficientCredits(siteId, 1, 0);
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(notificationQuery.insert).not.toHaveBeenCalled();
  });

  it('fails closed when the admission RPC rejects', async () => {
    mockRpc.mockRejectedValue(new Error('Synthetic database outage'));
    await expect(notifier.notifyInsufficientCredits(siteId, 1, 0)).resolves.toBeUndefined();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it.each(['failure', 'unconfirmed', 'exception'])('keeps the reservation after provider %s', async outcome => {
    if (outcome === 'exception') mockSendEmail.mockRejectedValue(new Error('Synthetic timeout'));
    else mockSendEmail.mockResolvedValue({ success: false, status: outcome, error: 'Synthetic failure' });
    await notifier.notifyInsufficientCredits(siteId, 1, 0);
    await notifier.notifyInsufficientCredits(siteId, 2, 0);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(reservations.size).toBe(1);
    expect(notificationQuery.insert).not.toHaveBeenCalled();
    expect(mockRpc.mock.calls.every(([name]) => name === 'claim_insufficient_credit_email')).toBe(true);
  });

  it.each(['error', 'exception'])('does not resend when notification insertion reports %s', async outcome => {
    if (outcome === 'exception') notificationQuery.insert.mockRejectedValue(new Error('Synthetic write outage'));
    else notificationQuery.insert.mockResolvedValue({ error: { message: 'Synthetic write outage' } });
    await notifier.notifyInsufficientCredits(siteId, 1, 0);
    await notifier.notifyInsufficientCredits(siteId, 2, 0);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(notificationQuery.insert).toHaveBeenCalledTimes(1);
    expect(reservations.size).toBe(1);
  });

  it('honors notifications sent before the admission migration without reserving a new attempt', async () => {
    notificationQuery.limit.mockResolvedValue({ data: [{ id: 'synthetic-notification' }], error: null });
    await notifier.notifyInsufficientCredits(siteId, 1, 0);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockGetUserById).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('fails closed if the legacy notification read fails', async () => {
    notificationQuery.limit.mockResolvedValue({ data: null, error: { message: 'Synthetic read outage' } });
    await notifier.notifyInsufficientCredits(siteId, 1, 0);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it.each([
    { data: null, error: { message: 'Unavailable' } },
    { data: { user: {} }, error: null },
  ])('does not reserve when the owner email is unavailable: %j', async response => {
    mockGetUserById.mockResolvedValue(response);
    await notifier.notifyInsufficientCredits(siteId, 1, 0);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('does not reserve when rendering fails before dispatch', async () => {
    (resolveEmailLocale as jest.Mock).mockRejectedValue(new Error('Synthetic locale outage'));
    await notifier.notifyInsufficientCredits(siteId, 1, 0);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});