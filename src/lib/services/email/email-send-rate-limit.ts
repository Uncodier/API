import { getRedisClient } from '@/lib/utils/redis-client';

const EMAIL_SEND_RATE_LIMIT_SECONDS = 60 * 60;

export interface EmailSendPermit {
  acquired: boolean;
  enforced: boolean;
  key: string;
}

export function buildEmailSendRateLimitKey(params: {
  instanceId?: string;
  siteId: string;
  email: string;
}): string {
  const validInstanceId = params.instanceId
    && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(params.instanceId)
    ? params.instanceId
    : null;
  return validInstanceId
    ? `rate_limit:send_email:${validInstanceId}:${params.email}`
    : `rate_limit:send_email:site_${params.siteId}:${params.email}`;
}

export async function acquireEmailSendPermit(params: {
  instanceId?: string;
  siteId: string;
  email: string;
}): Promise<EmailSendPermit> {
  const key = buildEmailSendRateLimitKey(params);
  try {
    const result = await getRedisClient().set(
      key,
      '1',
      'EX',
      EMAIL_SEND_RATE_LIMIT_SECONDS,
      'NX',
    );
    return { acquired: result === 'OK', enforced: true, key };
  } catch (error) {
    console.error('[sendEmail] Error acquiring atomic send permit:', error);
    return { acquired: true, enforced: false, key };
  }
}

export async function releaseEmailSendPermit(permit: EmailSendPermit): Promise<void> {
  if (!permit.acquired || !permit.enforced) return;
  try {
    await getRedisClient().del(permit.key);
  } catch (error) {
    console.error('[sendEmail] Error releasing send permit:', error);
  }
}
