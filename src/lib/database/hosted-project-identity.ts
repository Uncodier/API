import { Resolver } from 'node:dns/promises';
import { captureCatalogActorReply, captureDirectActorReply } from './supabase-admin';

const hosted = /^([a-z]{20})\.supabase\.co$/;
const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const nonPublicTld = new Set(['alt', 'arpa', 'corp', 'example', 'home', 'internal', 'invalid', 'lan', 'local', 'localdomain', 'localhost', 'onion', 'test']);

function originHost(origin: string): string | null {
  // Match the actual SDK constructor input, not a normalised URL that loses ports, userinfo or dot segments.
  if (origin.length > 262) return null;
  const host = /^https:\/\/([a-z0-9.-]{1,253})\/?$/.exec(origin)?.[1];
  if (!host) return null;
  if (hosted.test(host)) return host;
  const labels = host.split('.');
  const tld = labels[labels.length - 1];
  if (labels.length < 3 || !labels.every(part => label.test(part) && !part.startsWith('xn--')) ||
      !/^[a-z]{2,63}$/.test(tld) || nonPublicTld.has(tld) || /(?:^|\.)supabase\.(?:co|in)$/.test(host)) return null;
  return host;
}

async function projectRef(baseUrl: string, header: string | null): Promise<string | null> {
  const host = originHost(baseUrl);
  // Fetch Headers combines repeated sb-project-ref fields with a comma; never pick a value from a list.
  if (!host || (header !== null && (header.length !== 20 || !/^[a-z]{20}$/.test(header)))) return null;
  const direct = hosted.exec(host)?.[1];
  if (direct) return header === null || header === direct ? direct : null;
  if (header === null) return null;

  // https://supabase.com/docs/guides/platform/custom-domains#add-a-cname-record
  // Query only the configured FQDN's CNAME record, once. No alias walking or address/HTTP probes.
  const resolver = new Resolver({ timeout: 1000, tries: 1 });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const records = await Promise.race([
      resolver.resolveCname(`${host}.`),
      new Promise<null>(resolve => { timer = setTimeout(() => { resolve(null); resolver.cancel(); }, 1500); }),
    ]);
    const target = records?.length === 1 ? records[0].toLowerCase() : null;
    const expected = `${header}.supabase.co`;
    return target === expected || target === `${expected}.` ? header : null;
  } finally { clearTimeout(timer); }
}

/** Observe only the named server-owned actor RPC. A legacy or unrelated RPC cannot supply direct evidence. */
async function withActorEvidence(capture: typeof captureCatalogActorReply, check: () => Promise<boolean>) {
  const { allowed, reply } = await capture(check); // Preserve authorization errors.
  const localProjectRef = reply ? await projectRef(reply.baseUrl, reply.projectHeader).catch(() => null) : null;
  return { allowed, localProjectRef };
}
export const withCatalogActorEvidence = (check: () => Promise<boolean>) => withActorEvidence(captureCatalogActorReply, check);
export const withDirectActorEvidence = (check: () => Promise<boolean>) => withActorEvidence(captureDirectActorReply, check);
