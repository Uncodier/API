import { supabaseAdmin } from '@/lib/database/supabase-client';

type Resource = Record<string, any>;
export interface LicensedResources {
  social_media: Resource[];
  channels: Resource & { connections: Resource[] };
  effective_plan: 'commission' | 'engine' | 'foundry' | 'enterprise';
}

export class ResourceLicenseError extends Error {
  readonly code = 'RESOURCE_LICENSE_UNAVAILABLE';
  constructor(readonly status = 403) { super('The selected site resource is unavailable under the current license.'); }
}

const object = (value: unknown): value is Resource => !!value && typeof value === 'object' && !Array.isArray(value);
const resources = (value: unknown): value is Resource[] => Array.isArray(value)
  && value.every(row => object(row) && typeof row.license_suspended === 'boolean');

export const VOICE_ACTIVE_STATUSES = ['connected', 'active', 'synced'] as const;
const CONNECTED_ONLY_STATUSES = ['connected'] as const;

/** Provider-active aliases apply only to Voice, never to other channel types. */
export function isChannelActiveStatus(channel: string, status: unknown): boolean {
  const accepted: readonly string[] = channel === 'voice' ? VOICE_ACTIVE_STATUSES : CONNECTED_ONLY_STATUSES;
  return typeof status === 'string' && accepted.includes(status);
}

/** Server-only. Caller authorizes the site first. Never cache or fall back to raw settings. */
export async function getSiteLicensedResources(siteId: string, signal?: AbortSignal): Promise<LicensedResources> {
  if (!siteId) throw new ResourceLicenseError();
  let removeAbortListener = () => {};
  try {
    signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
    signal.throwIfAborted();
    const request = supabaseAdmin.rpc('get_site_licensed_resources', { p_site_id: siteId });
    const aborted = new Promise<never>((_, reject) => {
      const abort = () => reject(new ResourceLicenseError(503));
      signal!.addEventListener('abort', abort, { once: true });
      removeAbortListener = () => signal!.removeEventListener('abort', abort);
      if (signal!.aborted) abort();
    });
    const { data, error } = await Promise.race([request.abortSignal(signal), aborted]);
    signal.throwIfAborted();
    if (error || !object(data) || !resources(data.social_media) || !object(data.channels)
      || !resources(data.channels.connections)
      || !['commission', 'engine', 'foundry', 'enterprise'].includes(data.effective_plan)
      || data.social_media.some(row => row.isActive != null && ![true, false, 0, 1].includes(row.isActive))
      || data.channels.connections.some(row => row.status != null && typeof row.status !== 'string')) {
      throw new ResourceLicenseError();
    }
    return data as LicensedResources;
  } catch {
    // Do not expose RPC responses, resource credentials, or provider details.
    throw new ResourceLicenseError(503);
  } finally {
    removeAbortListener();
  }
}

export async function requireLicensedSocialAccounts(siteId: string, accountIds: string[]): Promise<void> {
  if (!accountIds.length || accountIds.some(id => typeof id !== 'string' || !id)) throw new ResourceLicenseError();
  const { social_media } = await getSiteLicensedResources(siteId);
  for (const id of accountIds) {
    const matches = social_media.filter(row => row.id === id);
    if (matches.length !== 1 || matches[0].license_suspended !== false
      || ![true, 1].includes(matches[0].isActive)) throw new ResourceLicenseError();
  }
}

export async function requireLicensedChannel(siteId: string, channel: string, connectionId: string,
  senderId?: string, signal?: AbortSignal): Promise<Resource> {
  if (typeof connectionId !== 'string' || !connectionId) throw new ResourceLicenseError();
  const { channels } = await getSiteLicensedResources(siteId, signal);
  const matches = channels.connections.filter(row => row.id === connectionId && row.type === channel);
  const row = matches[0];
  if (matches.length !== 1 || !isChannelActiveStatus(channel, row.status) || row.enabled === false || row.license_suspended !== false
    || (senderId && row.zavu_sender_id !== senderId)) throw new ResourceLicenseError();
  return row;
}