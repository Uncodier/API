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

/** Local preflight only: do not consume a durable delivery claim without config. */
export function getTransactionalEmailConfigurationError(): string | null {
  let provider: TransactionalEmailProvider;
  try { provider = getTransactionalEmailProvider(); }
  catch { return 'TRANSACTIONAL_EMAIL_PROVIDER must be sendgrid or zavu'; }
  const required = provider === 'sendgrid' ? ['SENDGRID_API_KEY'] : [
    'ZAVUDEV_API_KEY', 'TRANSACTIONAL_EMAIL_FROM_EMAIL',
    'TRANSACTIONAL_EMAIL_ZAVU_SITE_ID', 'TRANSACTIONAL_EMAIL_ZAVU_CONNECTION_ID',
  ];
  const missing = required.filter(name => !process.env[name]?.trim());
  if (missing.length) return `Configure ${missing.join(', ')}`;
  if (provider === 'zavu' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(getTransactionalEmailFrom()!)) {
    return 'Configure a valid TRANSACTIONAL_EMAIL_FROM_EMAIL';
  }
  return null;
}
