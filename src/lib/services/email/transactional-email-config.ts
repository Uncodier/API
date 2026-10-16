export type TransactionalEmailProvider = 'sendgrid' | 'zavu';

/** No implicit fallback: an invalid provider must not silently send elsewhere. */
export function getTransactionalEmailProvider(): TransactionalEmailProvider {
  const value = process.env.TRANSACTIONAL_EMAIL_PROVIDER?.trim().toLowerCase() || 'sendgrid';
  if (value !== 'sendgrid' && value !== 'zavu') {
    throw new Error('TRANSACTIONAL_EMAIL_PROVIDER must be sendgrid or zavu');
  }
  return value;
}

export function getTransactionalEmailFrom(): string | undefined {
  return process.env.TRANSACTIONAL_EMAIL_FROM_EMAIL?.trim();
}
