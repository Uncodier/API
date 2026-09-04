/**
 * Minimal egress allow-list for requirement sandboxes.
 * When a GitHub token is provided, inject Basic auth so the git remote
 * can stay tokenless (credential brokering via the sandbox proxy).
 */

const ALLOW_HOSTS = [
  'github.com',
  '*.github.com',
  '*.githubusercontent.com',
  '*.npmjs.org',
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  '*.yarnpkg.com',
  'vercel.com',
  '*.vercel.com',
  '*.vercel.app',
  '*.supabase.co',
  'supabase.com',
];

export const SANDBOX_FAILOVER_REGIONS = ['sfo1'] as const;

export function buildRequirementNetworkPolicy(githubToken?: string): {
  allow: string[] | Record<string, unknown[]>;
} {
  const token = githubToken?.trim();
  if (!token) return { allow: [...ALLOW_HOSTS] };

  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  const allow: Record<string, unknown[]> = {};
  for (const host of ALLOW_HOSTS) {
    allow[host] = [];
  }
  allow['github.com'] = [
    {
      transform: [{ headers: { Authorization: `Basic ${basic}` } }],
    },
  ];
  allow['*.github.com'] = [
    {
      transform: [{ headers: { Authorization: `Basic ${basic}` } }],
    },
  ];
  return { allow };
}

/** @deprecated use buildRequirementNetworkPolicy */
export const REQUIREMENT_SANDBOX_NETWORK_POLICY = buildRequirementNetworkPolicy();
