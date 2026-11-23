import { createHash } from 'node:crypto';
import { parseConnectorToolRef } from './connector-ref';
import { modelAccountIdentity } from './model-account-identity';
import { readDirectPosition, saveDirectPosition } from './support-discovery-continuation';
import { memberDiscoveryTargets, memberToolPage } from './support-member-discovery';
import { candidateWindow, denied } from './support-runtime-access';
import { memberSupportScope, type SupportConnectorScope } from './support-runtime-contract';

type Filter = { action: 'list' | 'search'; query?: string; cursor?: string; connector_id?: string };
export async function discoverSupport(input: SupportConnectorScope, filter: Filter, recheckHost: () => Promise<void>) {
  const parsed = memberSupportScope.safeParse(input);
  if (!parsed.success) return { success: false, status: 'unavailable' } as const;
  const scope = parsed.data;
  const context = createHash('sha256').update(JSON.stringify([scope, filter.action, filter.connector_id, filter.query])).digest();
  const { after, directCursor } = filter.cursor !== undefined ? readDirectPosition(filter.cursor, context) : { after: '', directCursor: undefined };
  const qualified = filter.query?.startsWith('connector:') ? parseConnectorToolRef(filter.query).connectorId : undefined;
  const exact = filter.connector_id ?? qualified;
  const candidates = qualified && qualified !== exact ? [] : await candidateWindow(scope, after, exact);
  if (exact && candidates.some(({ id }) => id !== exact)) throw denied();
  const batch = candidates.slice(0, 5);
  const targets = await memberDiscoveryTargets(scope, batch.map(row => row.id));
  const nextWindow = () => candidates.length > 5 ? saveDirectPosition({ after: batch[4].id }, context) : null;
  if (filter.action === 'list' && !exact) {
    await recheckHost();
    return { success: true, connectors: targets.map(({ connector }) => ({
      ...modelAccountIdentity(connector.id), toolkit: connector.toolkit_slug,
    })), next_cursor: nextWindow() };
  }
  // The inner cursor binds the authority kind and ID as well as the exact account and policy revisions.
  const page = await memberToolPage(scope, filter, targets, directCursor);
  await recheckHost();
  return { success: true, tools: page.tools, next_cursor: page.next_cursor
    ? saveDirectPosition({ after, directCursor: page.next_cursor }, context) : nextWindow() };
}
