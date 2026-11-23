import { z } from 'zod';
import { SUPPORT_CONNECTOR_TOOL } from './channel-tool-names';

import { approvalSource } from './approval-source';
const uuid = z.string().uuid();
const base = { siteId: uuid, conversationId: uuid, agentId: uuid, idempotencyKey: z.string().min(1).max(256), source: approvalSource.optional() };
export const memberSupportScope = z.object({ ...base, audience: z.literal('member'), userId: uuid }).strict();
export const supportScope = z.discriminatedUnion('audience', [
  memberSupportScope,
  z.object({ ...base, audience: z.literal('verified'), leadId: uuid }).strict(),
  z.object({ ...base, audience: z.literal('anonymous') }).strict(),
]);
export type SupportConnectorScope = z.infer<typeof supportScope>;
export type SupportConnectorHost = { siteId: string; agentId: string; messageDigest?: string; resolve: () => Promise<SupportConnectorScope | null> };

const name = z.string().min(1).max(220);
const cursor = z.string().max(128).optional();
export const supportInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), connector_id: uuid.optional(), cursor }).strict(),
  z.object({ action: z.literal('search'), query: z.string().trim().min(1).max(100), connector_id: uuid.optional(), cursor }).strict(),
  z.object({ action: z.literal('describe'), name }).strict(),
  z.object({ action: z.literal('call'), name, version: z.string().regex(/^[\w.-]{1,100}$/),
    schema_hash: z.string().regex(/^[a-f0-9]{64}$/), arguments: z.record(z.unknown()) }).strict(),
]);

export const supportConnectorTool = {
  name: SUPPORT_CONNECTOR_TOOL,
  description: 'Discover authorized support operations using list or search. Do not call manual_only entries. Describe one exact name, then call with the returned version, schema_hash and arguments. Never invent identifiers. Direct execution requires both member and assigned agent use access. A view-only member may explicitly request one-call human review using the separate proposal tool when available. On denial, do not retry or switch accounts. On outcome_unconfirmed, do not retry or claim completion. When result_omitted is true, report completion only; do not infer contents or retry through another account. Never invent a result or promise a response time.',
  parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
    action: { type: 'string', enum: ['list', 'search', 'describe', 'call'] },
    query: { type: 'string', maxLength: 100, description: 'Search only.' },
    connector_id: { type: 'string', description: 'Exact connector from list. Use list with this filter to see its tools.' },
    cursor: { type: 'string', maxLength: 128, description: 'Optional next_cursor from list or search.' },
    name: { type: 'string', maxLength: 220, description: 'Exact name for describe or call.' },
    version: { type: 'string', maxLength: 100, description: 'Call only: described version.' },
    schema_hash: { type: 'string', maxLength: 64, description: 'Call only: described schema hash.' },
    arguments: { type: 'object', description: 'Call only: exact operation arguments.' },
  } },
};
export const supportConnectorTools = [supportConnectorTool];