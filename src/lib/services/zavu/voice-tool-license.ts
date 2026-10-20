import {
  getSiteLicensedResources, isLicensedChannelConnection, requireLicensedChannel, ResourceLicenseError,
} from '@/lib/billing/licensed-resources';

/** Signed tool callbacks do not identify a sender in Zavu's current contract.
 * Fail closed for mixed enabled/disabled senders rather than borrowing another
 * connection's authorization. No provider I/O is needed for this admission.
 */
export async function requireVoiceToolLicense(siteId: string): Promise<() => Promise<void>> {
  const { channels } = await getSiteLicensedResources(siteId);
  const rows = channels.connections.filter(row => row.type === 'voice' && row.zavu_sender_id);
  if (!rows.length || rows.some(row => !isLicensedChannelConnection('voice', row)
    || typeof row.id !== 'string' || !row.id || typeof row.zavu_sender_id !== 'string')
    || new Set(rows.map(row => row.id)).size !== rows.length
    || new Set(rows.map(row => row.zavu_sender_id)).size !== rows.length) {
    throw new ResourceLicenseError();
  }
  // Pin identities and refresh after argument/context preparation, before execution.
  return async () => {
    for (const row of rows) await requireLicensedChannel(siteId, 'voice', row.id, row.zavu_sender_id);
  };
}