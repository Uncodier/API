import {
  SANDBOX_CREATE_TIMEOUT_MS,
  SANDBOX_SNAPSHOT_TTL_MS,
  SANDBOX_VISUAL_PROBE_PORT,
  sandboxVcpus,
} from '@/lib/services/sandbox-constants';
import {
  buildRequirementNetworkPolicy,
  SANDBOX_FAILOVER_REGIONS,
} from '@/lib/services/sandbox-network-policy';

export type SandboxCreateKind = 'git' | 'snapshot' | 'empty';

export function requirementSandboxTags(requirementId: string, instanceId?: string | null): Record<string, string> {
  const tags: Record<string, string> = { kind: 'requirement' };
  if (requirementId) tags.req = requirementId.slice(0, 8);
  if (instanceId) tags.instance = instanceId.slice(0, 8);
  return tags;
}

/**
 * Shared create payload. Extra v3 fields (name, persistent, keepLastSnapshots, tags)
 * are included when the SDK accepts them; v1 ignores unknown keys via the caller cast.
 */
export function buildSandboxCreateParams(opts?: {
  name?: string;
  snapshotId?: string;
  git?: { url: string; username?: string; password?: string; depth?: number; revision?: string };
  exposePreviewPort?: boolean;
  persistent?: boolean;
  tags?: Record<string, string>;
  /** Failover only on cold create — snapshots are region-bound. */
  coldCreate?: boolean;
  githubToken?: string;
}): Record<string, unknown> {
  const ports = opts?.exposePreviewPort === false ? [] : [SANDBOX_VISUAL_PROBE_PORT];
  const params: Record<string, unknown> = {
    runtime: process.env.SANDBOX_RUNTIME || 'node24',
    timeout: SANDBOX_CREATE_TIMEOUT_MS,
    resources: { vcpus: sandboxVcpus() },
    persistent: opts?.persistent ?? true,
    snapshotExpiration: SANDBOX_SNAPSHOT_TTL_MS,
    keepLastSnapshots: { count: 1, deleteEvicted: true },
  };
  if (ports.length) params.ports = ports;
  if (opts?.name) params.name = opts.name;
  if (opts?.tags) params.tags = opts.tags;
  params.networkPolicy = buildRequirementNetworkPolicy(opts?.githubToken || process.env.GITHUB_TOKEN);
  if (opts?.snapshotId) {
    params.source = { type: 'snapshot', snapshotId: opts.snapshotId };
  } else if (opts?.git) {
    params.source = {
      type: 'git',
      url: opts.git.url,
      username: opts.git.username,
      password: opts.git.password,
      depth: opts.git.depth ?? 1,
      ...(opts.git.revision ? { revision: opts.git.revision } : {}),
    };
    if (opts.coldCreate !== false) {
      params.failoverRegions = [...SANDBOX_FAILOVER_REGIONS];
    }
  } else if (opts?.coldCreate !== false && !opts?.snapshotId) {
    params.failoverRegions = [...SANDBOX_FAILOVER_REGIONS];
  }
  return params;
}
