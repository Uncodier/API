import { requireLicensedChannel, ResourceLicenseError } from '@/lib/billing/licensed-resources';
import { persistDeniedZavuInbound, type ZavuInboundHistory } from './inbound-message-history';

/** Preserve trusted incoming history even when automation is denied. */
export async function admitZavuInboundAutomation(input: ZavuInboundHistory): Promise<boolean> {
  try {
    await requireLicensedChannel(input.siteId, input.channel, input.connectionId, input.senderId);
    return true;
  } catch (error) {
    if (!(error instanceof ResourceLicenseError)) throw error;
    await persistDeniedZavuInbound(input);
    if (error.status !== 403) throw error; // Projection outages remain retryable, never execute.
    return false;
  }
}