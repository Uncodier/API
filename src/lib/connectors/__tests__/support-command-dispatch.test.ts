import { sourceDigest } from '../approval-source';
import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { generateSupportReply } from '@/app/api/agents/customerSupport/message/generate';
import { supportConnectorRequestHost } from '@/app/api/agents/customerSupport/message/connector-request-host';
import { commandService } from '@/app/api/agents/customerSupport/message/command-runtime';
import { CommandSubmitService } from '@/lib/agentbase/services/command/CommandSubmitService';
import { CommandStore } from '@/lib/agentbase/services/command/CommandStore';
import { DatabaseAdapter } from '@/lib/agentbase/adapters/DatabaseAdapter';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { commentConversationId, commentMetadata, conversationMetadata } from '@/lib/services/social-comments/metadata';
import { requestBoundCommandReview } from '../channel-command';
import { proposeConversationConnectorAction } from '../approval-proposals';

jest.mock('@/lib/agentbase', () => jest.requireActual('@/lib/agentbase/services/command/CommandFactory'));
jest.mock('@/lib/agentbase/adapters/DatabaseAdapter', () => ({ DatabaseAdapter: { createCommand: jest.fn() } }));
jest.mock('@/lib/agentbase/services/command/command-routing', () => ({ admitCommandRouting: jest.fn(), pinCommandRouting: jest.fn() }));
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn(), schema: jest.fn() } }));
jest.mock('@/lib/services/visitor-identity/VisitorSessionAuthorizationService', () => ({}));
jest.mock('@/lib/services/customer-support-tool-catalog', () => ({ buildCustomerSupportTools: () => [] }));
jest.mock('@/app/api/agents/customerSupport/message/command-runtime', () => ({ commandService: { submitCommand: jest.fn() },
  getCommandDbUuid: async (id: string) => id, waitForCommandCompletion: async (id: string) => ({ completed: true, command: { id }, dbUuid: id }) }));
jest.mock('../approval-proposals', () => ({ proposeConversationConnectorAction: jest.fn() }));

const serviceKey = randomBytes(32).toString('hex');
const oldKey = process.env.SERVICE_API_KEY;
beforeAll(() => { process.env.SERVICE_API_KEY = serviceKey; });
afterAll(() => { if (oldKey === undefined) delete process.env.SERVICE_API_KEY; else process.env.SERVICE_API_KEY = oldKey; });
afterEach(() => { CommandStore.clearAll(); jest.clearAllMocks(); });

it.each(['match', 'other persisted agent', 'other raw command', 'other agent role'])('%s: binds only the actual Support command during dispatch', async variant => {
  const siteId = randomUUID(), agentId = randomUUID(), owner = randomUUID(), id = randomUUID();
  const metadata = commentMetadata({ source: 'comment', publisher_account_id: 'account', outstand_post_id: 'post',
    platform_comment_id: 'comment', author_id: 'author' }, 'instagram')!;
  const conversationId = commentConversationId(siteId, metadata);
  const request = new Request('https://test.invalid', { headers: { 'x-api-key': serviceKey } });
  const rows: Record<string, object> = {
    agents: { id: agentId, site_id: siteId, status: 'active', role: variant === 'other agent role' ? 'Sales/CRM Specialist' : 'Customer Support' },
    conversations: { id: conversationId, site_id: siteId, agent_id: agentId, channel: metadata.channel, custom_data: conversationMetadata(metadata) },
    commands: { id: variant === 'other raw command' ? randomUUID() : id, site_id: siteId, agent_id: agentId, user_id: owner },
  };
  const from = (table: string) => {
    if (!(table in rows)) throw new Error(`Unexpected table ${table}`);
    const q = { select: () => q, eq: () => q, abortSignal: () => q, maybeSingle: async () => ({ data: rows[table] }) };
    return q;
  };
  jest.mocked(supabaseAdmin.schema).mockReturnValue({ from } as any);
  jest.mocked(supabaseAdmin.from).mockImplementation(from as any);
  const connectorHost = await supportConnectorRequestHost({ request, agentId, siteId, conversationId, metadata, origin: metadata.channel,
    browserIdentity: null, message: 'Support question' });
  const events = new EventEmitter();
  const submitter = new CommandSubmitService(events);
  jest.mocked(commandService.submitCommand).mockImplementation(submitter.submitCommand.bind(submitter));
  jest.mocked(DatabaseAdapter.createCommand).mockImplementation(async command => ({ ...command, id,
    created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString(),
    agent_id: variant === 'other persisted agent' ? randomUUID() : command.agent_id }));
  const proposal = { tool_slug: 'HUBSPOT_LIST_CONTACTS', arguments: { limit: 1 } };
  let reviewed: Promise<unknown> | undefined;
  events.once('commandCreated', command => { reviewed = requestBoundCommandReview(command.id, command.site_id, proposal); });
  const result = await generateSupportReply({ effectiveUserId: owner, effectiveSiteId: siteId, effectiveAgentId: agentId,
    effectiveConversationId: conversationId, contextMessage: 'Support question', connectorHost, request });
  expect(result).toMatchObject({ effectiveDbUuid: id });
  expect(reviewed).toBeDefined();
  await reviewed;
  const source = jest.mocked(DatabaseAdapter.createCommand).mock.calls[0][0];
  expect(source).toMatchObject({ site_id: siteId, agent_id: agentId, user_id: owner, agent_role: 'Customer Support' });
  expect(source).not.toHaveProperty('connectorHost');
  expect(source.tools?.map(tool => tool.function.name)).toEqual(variant === 'other agent role' ? [] : ['request_connector_review']);
  // Calling with identical IDs after event dispatch cannot recover the capability.
  await requestBoundCommandReview(id, siteId, proposal);
  expect(proposeConversationConnectorAction).toHaveBeenCalledTimes(variant === 'match' ? 1 : 0);
  if (variant === 'match') expect(proposeConversationConnectorAction).toHaveBeenCalledWith({ siteId, agentId, conversationId,
    idempotencyKey: expect.stringMatching(/^channel-request:/), source:{kind:'message',id:expect.any(String),digest:sourceDigest('Support question')} }, proposal);
});
