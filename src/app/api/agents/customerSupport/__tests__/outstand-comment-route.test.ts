import { POST } from '../message/route';
import { manageLeadCreation } from '@/lib/services/leads/lead-service';
import { OutstandLeadIdentityError } from '@/lib/services/leads/outstand-comment-identity';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { ConversationService } from '@/lib/services/conversation-service';
import { visitorSessionAuthorizationService } from '@/lib/services/visitor-identity/VisitorSessionAuthorizationService';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn(), schema: jest.fn() } }));
jest.mock('@/lib/services/leads/lead-service', () => ({ manageLeadCreation: jest.fn() }));
jest.mock('uuid', () => ({ v4: jest.fn() }));
jest.mock('@/lib/agentbase', () => ({
  CommandFactory: {},
  ProcessorInitializer: { getInstance: () => ({ initialize: jest.fn(), getCommandService: () => ({}) }) },
}));
jest.mock('@/lib/database/command-db', () => ({}));
jest.mock('@/lib/agentbase/adapters/DatabaseAdapter', () => ({}));
jest.mock('@/lib/services/customer-support-tool-catalog', () => ({}));
jest.mock('@/app/api/agents/customerSupport/support-policies', () => ({}));
jest.mock('@/app/api/agents/customerSupport/lead-record', () => ({}));
jest.mock('@/lib/promotions/context', () => ({}));
jest.mock('@/lib/services/workflow-robot/channel-message', () => ({}));
jest.mock('@/lib/security/request-rate-limit', () => ({ isInternalServiceRequest: () => true }));
jest.mock('@/lib/services/workflow-service', () => ({}));
jest.mock('@/lib/services/whatsapp/WhatsAppLeadService', () => ({}));
jest.mock('@/lib/services/conversation-service', () => ({
  ConversationService: { findExistingConversation: jest.fn() },
}));
jest.mock('@/lib/services/visitor-identity/VisitorSessionAuthorizationService', () => ({
  visitorAuthorizationErrorResponse: jest.fn(() => null),
  visitorSessionAuthorizationService: { authorizeBrowserRequest: jest.fn() },
}));

const siteId = '00000000-0000-4000-8000-000000000001';
const contract = {
  source: 'comment', outstand_post_id: 'post-1', author_id: 'urn:li:person:one',
  author_identity_status: 'resolve_on_read', publisher_account_id: 'account-1',
};

describe('Customer Support Outstand lead boundary (offline)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (visitorSessionAuthorizationService.authorizeBrowserRequest as jest.Mock).mockResolvedValue(null);
    (manageLeadCreation as jest.Mock).mockRejectedValue(new OutstandLeadIdentityError());
  });

  it('passes the new contract to lead management and aborts on a DB identity error', async () => {
    const response = await POST(new Request('http://localhost/api/agents/customerSupport/message', {
      method: 'POST', body: JSON.stringify({ site_id: siteId, message: 'Comment', origin: 'linkedin', custom_data: contract }),
    }));
    expect(manageLeadCreation).toHaveBeenCalledWith(expect.objectContaining({
      siteId, origin: 'linkedin', socialCommentData: contract,
    }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ success: false, error: {
      code: 'LEAD_IDENTITY_UNAVAILABLE', message: 'Unable to resolve Outstand commenter identity',
    } });
    expect(ConversationService.findExistingConversation).not.toHaveBeenCalled();
    expect(supabaseAdmin.from).not.toHaveBeenCalled();
    expect(supabaseAdmin.schema).not.toHaveBeenCalled();
  });

  it('continues forwarding legacy handles without opting them in to the new contract', async () => {
    await POST(new Request('http://localhost/api/agents/customerSupport/message', {
      method: 'POST', body: JSON.stringify({ site_id: siteId, message: 'DM', origin: 'instagram',
        custom_data: { account_username: 'legacy-handle' } }),
    }));
    expect(manageLeadCreation).toHaveBeenCalledWith(expect.objectContaining({
      socialHandle: 'legacy-handle', socialCommentData: { account_username: 'legacy-handle' },
    }));
  });
});