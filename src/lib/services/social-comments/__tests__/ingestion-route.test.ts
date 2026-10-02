import { POST } from '@/app/api/agents/customerSupport/message/route';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { database } from './database';
import { generateSupportReply } from '@/app/api/agents/customerSupport/message/generate';
import { ConversationService } from '@/lib/services/conversation-service';

const site = '00000000-0000-4000-8000-000000000001';
const user = '00000000-0000-4000-8000-000000000002';
const agent = '00000000-0000-4000-8000-000000000003';
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('@/lib/services/visitor-identity/VisitorSessionAuthorizationService', () => ({
  visitorAuthorizationErrorResponse: () => null,
  visitorSessionAuthorizationService: { authorizeBrowserRequest: jest.fn().mockResolvedValue(null) },
}));
jest.mock('@/lib/security/request-rate-limit', () => ({ isInternalServiceRequest: () => true }));
jest.mock('@/lib/services/leads/lead-service', () => ({ manageLeadCreation: jest.fn().mockResolvedValue({ leadId: null }) }));
jest.mock('@/lib/services/whatsapp/WhatsAppLeadService', () => ({ WhatsAppLeadService: {} }));
jest.mock('@/lib/services/conversation-service', () => ({ ConversationService: { findExistingConversation: jest.fn() } }));
jest.mock('@/app/api/agents/customerSupport/message/context', () => ({ buildSupportContext: jest.fn().mockResolvedValue('Context') }));
jest.mock('@/app/api/agents/customerSupport/message/generate', () => ({ generateSupportReply: jest.fn() }));
jest.mock('@/app/api/agents/customerSupport/message/agent-data', () => ({
  isValidUUID: (value: string) => /^[0-9a-f-]{36}$/.test(value),
  findActiveCustomerSupportAgent: () => ({ agentId: '00000000-0000-4000-8000-000000000003', userId: '00000000-0000-4000-8000-000000000002' }),
}));
jest.mock('../ownership', () => ({ authorizeCommentAccount: async () => ({ username: 'owned', platformPostId: 'platform-post' }) }));
jest.mock('uuid', () => {
  const v5 = (value: string) => {
    const hash = require('node:crypto').createHash('sha256').update(value).digest('hex');
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  };
  v5.URL = 'namespace'; return { v5 };
});

it('wires ingestion, deterministic selection and AI proposal persistence without generic latest lookup', async () => {
  const db = database();
  (supabaseAdmin.from as jest.Mock).mockImplementation(db.from);
  db.tables.sites.push({ id: site, user_id: user });
  (generateSupportReply as jest.Mock).mockResolvedValue({
    executedCommand: { results: [{ message: { content: 'AI proposal' } }] }, effectiveDbUuid: undefined,
  });
  const request = (comment: string) => new Request('http://localhost/api/agents/customerSupport/message', {
    method: 'POST', body: JSON.stringify({ site_id: site, message: 'Question', origin: 'instagram',
      origin_message_id: `instagram:${comment}`, channel_delivery: true, require_approval: true,
      custom_data: { source: 'comment', author_id: 'author', author_identity_status: 'unavailable',
        publisher_account_id: 'owned-account', outstand_post_id: 'post', platform_comment_id: comment },
    }),
  });
  const first = await POST(request('one'));
  const firstBody = await first.json();
  expect(first.status).toBe(200);
  expect(firstBody.data.messages.assistant.content).toBe('AI proposal');
  const second = await POST(request('two'));
  expect(second.status).toBe(200);
  expect(db.tables.conversations).toHaveLength(1);
  expect(db.tables.conversations[0].agent_id).toBe(agent);
  expect(db.tables.messages).toHaveLength(4);
  const firstReply = db.tables.messages.find(row => row.id === firstBody.data.messages.assistant.message_id)!;
  expect(firstReply.custom_data).toMatchObject({ status: 'pending', source: 'comment',
    reply_to_message_id: firstBody.data.messages.user.message_id, reply_to_comment_id: 'one' });
  expect(ConversationService.findExistingConversation).not.toHaveBeenCalled();
  const retry = await POST(request('one'));
  expect((await retry.json()).skipped).toBe('duplicate');
  expect(generateSupportReply).toHaveBeenCalledTimes(2);
});