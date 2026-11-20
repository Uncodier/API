import { approvalSource } from './approval-source';
import { z } from 'zod';
import { hashConnectorSchema, type describeConnectorTool } from './composio-sessions';
import { ConnectorError, type AuthorizedConnector } from './types';

const uuid = z.string().uuid();
export const storedAction = z.object({
  source: approvalSource.optional(),
  origin: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('interactive'), instance_id: uuid, user_id: uuid }).strict(),
    z.object({ kind: z.literal('channel_member'), user_id: uuid }).strict(),
    z.object({ kind: z.literal('channel_public'), lead_id: uuid.nullable() }).strict(),
    z.object({ kind: z.literal('conversation') }).strict(),
    z.object({ kind: z.literal('support_member'), user_id: uuid }).strict(),
    z.object({ kind: z.literal('support_publication'), audience: z.enum(['verified','anonymous']),
      publication_hash: z.string().regex(/^[a-f0-9]{64}$/), lead_id: uuid.nullable() }).strict(),
  ]),
  connector_id: uuid, account_label: z.string(), tool_slug: z.string(), version: z.string(),
  schema_hash: z.string().regex(/^[a-f0-9]{64}$/), binding: z.string().regex(/^[a-f0-9]{64}$/),
  scopes: z.array(z.string()), arguments: z.record(z.unknown()),
}).strict();
export type StoredAction = z.infer<typeof storedAction>;
export type Descriptor = Awaited<ReturnType<typeof describeConnectorTool>>;
export type ApprovalRow = { connector_approval_review_links?: { review_conversation_id: string } | null; id: string; site_id: string; agent_id: string; conversation_id: string | null;
  action: StoredAction; status: string; actor_user_id: string | null; created_at: string; expires_at: string };
export const unavailable = () => new ConnectorError('APPROVAL_UNAVAILABLE', 'This approval is no longer actionable.', 409);

/** Include the account, provider credential revision, restrictions and both revisions;
 * never store a provider key. Canonical hash is independent of JSONB key order. */
export const approvalBinding = ({ connector, provider, policy }: AuthorizedConnector) => hashConnectorSchema({ connector, provider, policy });

export function actionSnapshot(origin: StoredAction['origin'], access: AuthorizedConnector, descriptor: Descriptor,
  args: Record<string, unknown>): StoredAction {
  return storedAction.parse({ origin, connector_id: access.connector.id, account_label: access.connector.display_name,
    tool_slug: descriptor.slug, version: descriptor.toolkitVersion, schema_hash: descriptor.schemaHash,
    binding: approvalBinding(access), scopes: descriptor.scopes, arguments: args });
}
