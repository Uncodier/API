import { runInNewContext } from 'node:vm';
import {
  formatCreditExhaustionNotice, InsufficientCreditsError, isInsufficientCreditsError,
} from '../credit-exhaustion-message';
import type { CreditExhaustionBilling } from '../credit-exhaustion-message';

describe('isInsufficientCreditsError (pure identity checks)', () => {
  it('recognizes the class instance even if its name is overwritten', () => {
    const error = new InsufficientCreditsError('Synthetic shortage');
    error.name = 'Error';
    expect(isInsufficientCreditsError(error)).toBe(true);
  });

  it('recognizes exact names on cross-realm errors and serialized errors', () => {
    const foreignError = runInNewContext("Object.assign(new Error('Synthetic shortage'), { name: 'InsufficientCreditsError' })");
    expect(foreignError instanceof Error).toBe(false);
    expect(isInsufficientCreditsError(foreignError)).toBe(true);
    expect(isInsufficientCreditsError({ name: 'InsufficientCreditsError' })).toBe(true);
  });

  it.each([
    null, undefined, 0, false, 'InsufficientCreditsError', 'Insufficient credits',
    new Error('Insufficient credits'), { message: 'Not enough credits' },
    { error: 'InsufficientCreditsError' }, { name: 'Error', message: 'InsufficientCreditsError' },
    { name: 'insufficientcreditserror' }, { name: ' InsufficientCreditsError ' },
    { name: 'BillingUnavailableError' },
  ])('does not classify arbitrary text or unrelated errors: %s', error => {
    expect(isInsufficientCreditsError(error)).toBe(false);
  });

  it('follows object causes without consulting messages', () => {
    const error = new Error('Synthetic wrapper', {
      cause: { name: 'Error', cause: new InsufficientCreditsError('Synthetic shortage') },
    });
    expect(isInsufficientCreditsError(error)).toBe(true);
    expect(isInsufficientCreditsError(new Error('Insufficient credits', { cause: 'InsufficientCreditsError' }))).toBe(false);
  });

  it('bounds the cause chain to eight objects', () => {
    let cause: object = { name: 'InsufficientCreditsError' };
    for (let index = 0; index < 7; index++) cause = { cause };
    expect(isInsufficientCreditsError(cause)).toBe(true);
    expect(isInsufficientCreditsError({ cause })).toBe(false);
  });

  it('terminates cycles while still finding identity before a cycle repeats', () => {
    const cyclic: { cause?: unknown; name?: string } = {};
    cyclic.cause = cyclic;
    expect(isInsufficientCreditsError(cyclic)).toBe(false);
    cyclic.name = 'InsufficientCreditsError';
    expect(isInsufficientCreditsError(cyclic)).toBe(true);
  });

  it('treats malformed getters and proxies as unknown rather than throwing', () => {
    const badName = Object.defineProperty({}, 'name', { get() { throw new Error('Synthetic getter failure'); } });
    const badCause = Object.defineProperty({}, 'cause', { get() { throw new Error('Synthetic getter failure'); } });
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(isInsufficientCreditsError(badName)).toBe(false);
    expect(isInsufficientCreditsError(badCause)).toBe(false);
    expect(isInsufficientCreditsError(proxy)).toBe(false);
  });
});

describe('formatCreditExhaustionNotice (pure Spanish billing notice)', () => {
  const now = new Date('2030-10-15T12:00:00Z');
  const billing: CreditExhaustionBilling = {
    credits_available: 0.25,
    status: 'active',
    plan_credit_period_end: '2030-11-01T00:00:00Z',
    plan_credit_allowance: 20,
    stripe_subscription_id: null,
    subscription_status: null,
  };

  it('formats the exact stored renewal end in Spanish UTC and preserves fractional remaining credits', () => {
    const result = formatCreditExhaustionNotice(billing, now);
    expect(result).toEqual({
      message: 'Tus créditos se han agotado para continuar este ciclo. Créditos disponibles: 0.25. Tu asignación de créditos se renovará el 1 de noviembre de 2030 a las 00:00:00 UTC. Puedes comprar créditos adicionales o revisar tu facturación.',
      nextResetAt: '2030-11-01T00:00:00.000Z',
      available: 0.25,
    });
  });

  it('converts the stored timezone to UTC, not the host timezone', () => {
    const result = formatCreditExhaustionNotice({
      ...billing, plan_credit_period_end: '2030-11-01T00:30:45.123456+02:00',
    }, now);
    expect(result.nextResetAt).toBe('2030-10-31T22:30:45.123Z');
    expect(result.message).toContain('31 de octubre de 2030 a las 22:30:45 UTC');
  });

  it('accepts a valid stored PostgreSQL timestamp with a timezone and a leap day', () => {
    const result = formatCreditExhaustionNotice({
      ...billing, plan_credit_period_end: '2032-02-29 00:00:00+00:00',
    }, now);
    expect(result.nextResetAt).toBe('2032-02-29T00:00:00.000Z');
  });

  it('defaults to the runtime clock when not passed explicitly', () => {
    jest.useFakeTimers().setSystemTime(now);
    try {
      expect(formatCreditExhaustionNotice(billing)).toEqual(formatCreditExhaustionNotice(billing, now));
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    undefined, null, '', 'invalid', 'Infinity', Infinity, 1919721600000, new Date('2030-11-01T00:00:00Z'),
    '2030-11-01', '2030-11-01T00:00:00', '2030-02-30T00:00:00Z',
    '2031-02-29T00:00:00Z', '2032-02-30T00:00:00Z', '2030-11-31T00:00:00Z',
    '2030-13-01T00:00:00Z', '2030-00-01T00:00:00Z', '2030-11-00T00:00:00Z',
    '2030-11-01T24:00:00Z', '2030-11-01T00:60:00Z', '2030-11-01T00:00:60Z',
    '2030-11-01T00:00:00+25:00', '2030-11-01T00:00:00+00:60',
    '2030-10-01T00:00:00Z', '2030-10-15T12:00:00Z',
  ])('does not guess an invalid/missing/past next reset: %s', end => {
    const result = formatCreditExhaustionNotice({ ...billing, plan_credit_period_end: end }, now);
    expect(result.nextResetAt).toBeNull();
    expect(result.available).toBe(0.25);
    expect(result.message).toContain('No hay una fecha de renovación confirmada.');
    expect(result.message).not.toContain('se renovará el');
  });

  it.each([undefined, null, '', 'inactive', 'past_due', 'canceled', 'ACTIVE', false])(
    'requires a confirmed active billing account, not %s', status => {
      const result = formatCreditExhaustionNotice({ ...billing, status }, now);
      expect(result.nextResetAt).toBeNull();
      expect(result.available).toBe(0.25);
    },
  );

  it.each([undefined, null, 0, -1, NaN, Infinity, -Infinity, '20', false, {}])(
    'requires a positive finite numeric allowance, not %s', allowance => {
      expect(formatCreditExhaustionNotice({ ...billing, plan_credit_allowance: allowance }, now).nextResetAt).toBeNull();
    },
  );

  it.each([undefined, null, NaN, Infinity, -Infinity, -1, '0', '10', false, {}, []])(
    'keeps invalid balance %s unknown rather than pretending zero', credits => {
      const result = formatCreditExhaustionNotice({ ...billing, credits_available: credits }, now);
      expect(result.available).toBeNull();
      expect(result.message).not.toContain('Créditos disponibles:');
      expect(result.nextResetAt).toBe('2030-11-01T00:00:00.000Z'); // Entitlement is separate from balance validity.
    },
  );

  it.each([0, 0.00000001, 5])('reports the confirmed balance %s without rounding to zero', credits => {
    const result = formatCreditExhaustionNotice({ ...billing, credits_available: credits }, now);
    expect(result.available).toBe(credits);
    expect(result.message).toContain(`Créditos disponibles: ${credits}.`);
  });

  it('returns a useful unknown fallback without claiming a remaining balance or a guessed date', () => {
    const fallback = formatCreditExhaustionNotice(null, now);
    expect(fallback).toEqual({
      message: 'Tus créditos se han agotado para continuar este ciclo. No hay una fecha de renovación confirmada. Puedes comprar créditos adicionales o revisar tu facturación.',
      nextResetAt: null, available: null,
    });
    expect(formatCreditExhaustionNotice({}, now)).toEqual(fallback);
  });

  it('makes Stripe renewal explicitly conditional on confirmed renewal payment', () => {
    const result = formatCreditExhaustionNotice({
      ...billing, stripe_subscription_id: 'synthetic-subscription', subscription_status: 'active',
    }, now);
    expect(result.nextResetAt).toBe('2030-11-01T00:00:00.000Z');
    expect(result.message).toContain('podrá renovarse el 1 de noviembre de 2030 a las 00:00:00 UTC');
    expect(result.message).toContain('siempre que se confirme el pago de renovación de tu suscripción en Stripe.');
    expect(result.message).not.toContain('se renovará el');
  });

  it('promises a monthly reset within an already paid annual coverage, not another payment', () => {
    const result = formatCreditExhaustionNotice({
      ...billing, stripe_subscription_id: 'synthetic-subscription', subscription_status: 'active',
      billing_interval: 'year', paid_subscription_period_end: '2031-10-01T00:00:00Z',
    }, now);
    expect(result.message).toContain('se renovará el 1 de noviembre de 2030');
    expect(result.message).not.toContain('siempre que se confirme el pago');
  });

  it('requires another payment at the final annual boundary', () => {
    const result = formatCreditExhaustionNotice({
      ...billing, stripe_subscription_id: 'synthetic-subscription', subscription_status: 'active',
      billing_interval: 'year', paid_subscription_period_end: billing.plan_credit_period_end,
    }, now);
    expect(result.message).toContain('siempre que se confirme el pago');
  });

  it.each([undefined, null, '', 'past_due', 'unpaid', 'canceled', 'cancelled', 'incomplete_expired', 'trialing', false])(
    'does not promise Stripe renewal for an unknown/inactive subscription %s', subscription_status => {
      const result = formatCreditExhaustionNotice({ ...billing, stripe_subscription_id: 'synthetic-subscription', subscription_status }, now);
      expect(result.nextResetAt).toBeNull();
      expect(result.message).toContain('No hay una fecha de renovación confirmada.');
    },
  );

  it.each([undefined, '', '   ', false, 123, {}])('does not guess subscription management for malformed/missing id %s', id => {
    const result = formatCreditExhaustionNotice({ ...billing, stripe_subscription_id: id, subscription_status: 'active' }, now);
    expect(result.nextResetAt).toBeNull();
  });

  it('does not invent a Stripe renewal date even for an active paid-looking subscription', () => {
    const result = formatCreditExhaustionNotice({
      ...billing, stripe_subscription_id: 'synthetic-subscription', subscription_status: 'active',
      plan_credit_period_end: '2030-10-01T00:00:00Z',
    }, now);
    expect(result.nextResetAt).toBeNull();
    expect(result.message).not.toContain('1 de noviembre');
  });
});