export type TransactionalEmailProvider = 'sendgrid' | 'zavu';

export interface TransactionalEmailDiagnostic {
  stage: 'configuration' | 'validation' | 'sender_resolution' | 'sender_verification' | 'dispatch' | 'acceptance';
  code: 'invalid_provider' | 'missing_configuration' | 'invalid_from_address' | 'invalid_request'
    | 'unsupported_feature' | 'connection_lookup_failed' | 'connection_mismatch'
    | 'sender_not_verified' | 'provider_auth_failed' | 'provider_balance_exhausted'
    | 'provider_rate_limited' | 'provider_rejected' | 'deadline_exceeded'
    | 'provider_unavailable' | 'message_not_accepted';
  httpStatus?: number;
  missingConfiguration?: string[];
}

/** Log only operator-owned names and allowlisted codes, never provider bodies. */
export function getTransactionalEmailConfigurationDiagnostic(): TransactionalEmailDiagnostic | null {
  let provider: TransactionalEmailProvider;
  try { provider = getTransactionalEmailProvider(); }
  catch { return { stage: 'configuration', code: 'invalid_provider' }; }
  const required = provider === 'sendgrid' ? ['SENDGRID_API_KEY'] : [
    'ZAVUDEV_API_KEY', 'TRANSACTIONAL_EMAIL_FROM_EMAIL',
    'TRANSACTIONAL_EMAIL_ZAVU_SITE_ID', 'TRANSACTIONAL_EMAIL_ZAVU_CONNECTION_ID',
  ];
  const missingConfiguration = required.filter(name => !process.env[name]?.trim());
  if (missingConfiguration.length) return { stage: 'configuration', code: 'missing_configuration', missingConfiguration };
  if (provider === 'zavu' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(getTransactionalEmailFrom()!)) {
    return { stage: 'configuration', code: 'invalid_from_address' };
  }
  return null;
}

export function getTransactionalEmailFailureDiagnostic(
  error: unknown, stage: TransactionalEmailDiagnostic['stage']
): TransactionalEmailDiagnostic {
  const status = (error as { status?: unknown; response?: { statusCode?: unknown } })?.status
    ?? (error as { response?: { statusCode?: unknown } })?.response?.statusCode;
  const httpStatus = typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599 ? status : undefined;
  const name = (error as { name?: unknown })?.name;
  const code: TransactionalEmailDiagnostic['code'] = name === 'TimeoutError' || name === 'AbortError' ? 'deadline_exceeded'
    : httpStatus === 401 || httpStatus === 403 ? 'provider_auth_failed'
    : httpStatus === 402 ? 'provider_balance_exhausted'
    : httpStatus === 429 ? 'provider_rate_limited'
    : httpStatus && httpStatus < 500 ? 'provider_rejected' : 'provider_unavailable';
  return { stage, code, ...(httpStatus ? { httpStatus } : {}) };
}

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
  const diagnostic = getTransactionalEmailConfigurationDiagnostic();
  if (!diagnostic) return null;
  if (diagnostic.code === 'invalid_provider') return 'TRANSACTIONAL_EMAIL_PROVIDER must be sendgrid or zavu';
  if (diagnostic.code === 'invalid_from_address') return 'Configure a valid TRANSACTIONAL_EMAIL_FROM_EMAIL';
  return `Configure ${diagnostic.missingConfiguration!.join(', ')}`;
}
