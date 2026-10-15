import { Sandbox } from '@vercel/sandbox';

export type ListedSandbox = { id: string; name?: string; createdAt?: string | number };
/** SDK v3 returns a name, not a legacy id. Never key all such rows by undefined. */
export function collectListedSandboxes(list: unknown): ListedSandbox[] {
  if (!list) return [];
  const rec = list as { json?: { sandboxes?: Array<{ id?: string; name?: string; createdAt?: string | number }> };
    sandboxes?: Array<{ id?: string; name?: string; createdAt?: string | number }> };
  return (rec.json?.sandboxes ?? rec.sandboxes ?? []).filter(sb => !!(sb.name || sb.id))
    .map(sb => ({ id: sb.name || sb.id!, name: sb.name, createdAt: sb.createdAt }));
}

export async function listHousekeepingSandboxes(credentials: { token: string; projectId: string; teamId: string }): Promise<ListedSandbox[]> {
  const out = new Map<string, ListedSandbox>();
  const listFn = Sandbox.list.bind(Sandbox) as (opts: Record<string, unknown>) => Promise<unknown>;
  let cursor: string | undefined, until: number | undefined;
  const seen = new Set<string | number>();
  for (let page = 0; page < 1000; page++) {
    const list = await listFn({ ...credentials, limit: 100, ...(cursor ? { cursor } : {}), ...(until ? { until } : {}) });
    const items = collectListedSandboxes(list);
    items.forEach(row => out.set(row.id, row));
    const rec = list as { json?: { pagination?: { next?: number | string | null } }; pagination?: { next?: number | string | null } };
    const next = rec.json?.pagination?.next ?? rec.pagination?.next;
    if (!next) return [...out.values()];
    if (!items.length || seen.has(next)) throw new Error('Sandbox list pagination did not advance');
    seen.add(next);
    if (typeof next === 'string') cursor = next; else until = next;
  }
  throw new Error('Sandbox list pagination limit exceeded');
}