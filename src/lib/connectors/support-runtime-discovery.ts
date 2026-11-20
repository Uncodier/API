import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { z } from 'zod';
import { candidateWindow, denied, supportInventory } from './support-runtime-access';
import { createActionRanker } from './action-search';
import { connectorToolRef } from './reviewed-tools';
import { ConnectorError } from './types';
import type { SupportConnectorScope } from './support-runtime-contract';

// Command authority is process-local. A restart invalidates pagination; it cannot restore a host.
const key = randomBytes(32);
function seal(id: string, context: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv).setAAD(context);
  const bytes = Buffer.concat([cipher.update(id), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64url');
}
function open(cursor: string, context: Buffer) {
  const bytes = Buffer.from(cursor, 'base64url');
  if (bytes.length < 30 || bytes.length > 96) throw denied();
  const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)).setAAD(context).setAuthTag(bytes.subarray(12,28));
  return z.tuple([z.union([z.literal(''), z.string().uuid()]), z.number().int().nonnegative(), z.string().max(12)])
    .parse(JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString()));
}
const rankActions = createActionRanker();
const toolkitDescriptions: Record<string, string> = {
  gmail: 'Email and mailbox operations.', hubspot: 'Customer relationship management and contact records.',
  supabase: 'Database and project metadata.',
};
type Filter = {action: 'list' | 'search'; query?: string; cursor?: string; connector_id?: string};
export async function discoverSupport(scope: SupportConnectorScope, filter: Filter, recheckHost: () => Promise<void>) {
  const catalog = filter.action === 'list' && !filter.connector_id;
  const words = (filter.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const context = createHash('sha256').update(JSON.stringify([scope, filter.action, filter.connector_id, words])).digest();
  const [after, offset, previous] = filter.cursor ? open(filter.cursor, context) : ['', 0, ''] as const;
  const candidates = await candidateWindow(scope, after, filter.connector_id);
  const inventory = supportInventory(scope);
  const batch = candidates.slice(0, 5);
  const accounts = await Promise.all(batch.map(async ({id}) => {
    try { return { id, ...await inventory(id) }; }
    catch (error) {
      if (error instanceof ConnectorError && [403,404,409].includes(error.status)) return { id, tools: [], label: undefined };
      throw error;
    }
  }));
  const scores = filter.query ? await rankActions(accounts.flatMap(account => account.tools), filter.query) : new Map<string, number>();
  const ranked = accounts.flatMap(({ id, tools, label }) => (catalog ? tools.slice(0, 1) : tools).map(tool => ({
    score: scores.get(tool.slug) ?? 0,
    item: { connector_id: id, toolkit: tool.toolkit,
      description: catalog && scope.audience === 'member' ? toolkitDescriptions[tool.toolkit] ?? tool.toolkit : tool.description,
      ...(!catalog ? { name: connectorToolRef(id, tool.slug) } : {}), ...(label ? { account_label: label } : {}) },
  }))).filter(row => !filter.query || row.score > 0)
    .sort((a, b) => b.score - a.score || a.item.connector_id.localeCompare(b.item.connector_id) || (a.item.name ?? '').localeCompare(b.item.name ?? ''));
  const signature = createHash('sha256').update(JSON.stringify(ranked.map(({item}) => [item.connector_id, item.name]))).digest('hex').slice(0, 12);
  if (offset > 0 && signature !== previous) {
    await recheckHost();
    throw new ConnectorError('STALE_CURSOR', 'Results changed. Repeat discovery without the cursor.', 409);
  }
  const entries = ranked.slice(offset, offset + 5).map(row => row.item);
  const next = ranked.length > offset + 5 ? [after, offset + 5, signature] : candidates.length > 5 ? [batch[4].id, 0, ''] : null;
  await recheckHost();
  return { success: true, ...(catalog ? { connectors: entries } : { tools: entries }),
    next_cursor: next ? seal(JSON.stringify(next), context) : null };
}