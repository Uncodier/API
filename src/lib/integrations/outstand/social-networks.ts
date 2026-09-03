export const OUTSTAND_NETWORKS: Record<string, string> = {
  facebook: 'facebook',
  twitter: 'x',
  x: 'x',
  instagram: 'instagram',
  threads: 'threads',
  linkedin: 'linkedin',
  youtube: 'youtube',
  tiktok: 'tiktok',
  pinterest: 'pinterest',
  bluesky: 'bluesky',
  github: 'github',
  reddit: 'reddit',
  medium: 'medium',
  whatsapp: 'whatsapp',
  telegram: 'telegram',
  discord: 'discord',
};

export function resolveOutstandNetwork(network: string): string | null {
  if (!network) return null;
  return OUTSTAND_NETWORKS[network.toLowerCase()] ?? null;
}
