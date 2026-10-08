/** Pure billing notice helpers: no database, credentials or notification dependencies. */
export class InsufficientCreditsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InsufficientCreditsError';
  }
}

export interface CreditExhaustionNotice {
  message: string;
  nextResetAt: string | null;
  available: number | null;
}

/** Billing responses are untrusted at runtime, even when the database has numeric columns. */
export interface CreditExhaustionBilling {
  credits_available?: unknown;
  status?: unknown;
  plan_credit_period_end?: unknown;
  plan_credit_allowance?: unknown;
  stripe_subscription_id?: unknown;
  subscription_status?: unknown;
  billing_interval?: unknown;
  paid_subscription_period_end?: unknown;
}

/** Only explicit error identity counts; never infer a shortage from message text. */
export function isInsufficientCreditsError(error: unknown): boolean {
  const visited = new Set<object>();
  let current = error;
  for (let depth = 0; depth < 8; depth++) {
    if (current === null || typeof current !== 'object' || visited.has(current)) return false;
    visited.add(current);
    try {
      if (current instanceof InsufficientCreditsError ||
        (current as { name?: unknown }).name === 'InsufficientCreditsError') return true;
      current = (current as { cause?: unknown }).cause;
    } catch {
      // Malformed error objects (including throwing getters/proxies) are not evidence.
      return false;
    }
  }
  return false;
}

function creditAmount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function storedRenewalEnd(value: unknown, now: Date): Date | null {
  if (typeof value !== 'string') return null;
  // Require an explicit timezone. Date-only/local strings and JS's calendar rollover
  // (e.g. February 30) must not turn unknown/invalid billing dates into promises.
  const parts = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/i.exec(value);
  if (!parts) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone] = parts;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] ||
    Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText) > 59 ||
    (zone.toUpperCase() !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59))) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > now.getTime() ? new Date(timestamp) : null;
}

/** A read-only notice, intended for use after a confirmed shortage. No renewal dates are invented. */
export function formatCreditExhaustionNotice(
  billing: CreditExhaustionBilling | null = null,
  now: Date = new Date(),
): CreditExhaustionNotice {
  const available = creditAmount(billing?.credits_available);
  const allowance = creditAmount(billing?.plan_credit_allowance);
  const nonStripe = billing?.stripe_subscription_id === null;
  const activeStripe = typeof billing?.stripe_subscription_id === 'string' &&
    billing.stripe_subscription_id.trim().length > 0 &&
    typeof billing.subscription_status === 'string' && billing.subscription_status.toLowerCase() === 'active';
  const renewalEnd = billing?.status === 'active' && allowance !== null && allowance > 0 &&
    (nonStripe || activeStripe) ? storedRenewalEnd(billing?.plan_credit_period_end, now) : null;
  const paidThrough = billing?.billing_interval === 'year'
    ? storedRenewalEnd(billing.paid_subscription_period_end, now) : null;
  const coveredMonthlyReset = activeStripe && renewalEnd !== null && paidThrough !== null &&
    paidThrough.getTime() > renewalEnd.getTime();

  let message = 'Tus créditos se han agotado para continuar este ciclo.';
  if (available !== null) message += ` Créditos disponibles: ${available}.`;
  if (renewalEnd) {
    const date = new Intl.DateTimeFormat('es-ES', {
      day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
    }).format(renewalEnd);
    const exactDate = `${date} a las ${renewalEnd.toISOString().slice(11, 19)} UTC`;
    message += activeStripe && !coveredMonthlyReset
      ? ` Tu asignación de créditos podrá renovarse el ${exactDate}, siempre que se confirme el pago de renovación de tu suscripción en Stripe.`
      : ` Tu asignación de créditos se renovará el ${exactDate}.`;
  } else {
    message += ' No hay una fecha de renovación confirmada.';
  }
  message += ' Puedes comprar créditos adicionales o revisar tu facturación.';
  return { message, nextResetAt: renewalEnd?.toISOString() ?? null, available };
}