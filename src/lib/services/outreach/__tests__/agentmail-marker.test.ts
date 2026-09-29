jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('@/lib/integrations/agentmail/agentmail-service', () => ({ sendMessage: jest.fn() }));
jest.mock('@/lib/services/tracking/EmailTrackingService', () => ({ EmailTrackingService: { injectTracking: (html: string) => html } }));
jest.mock('@/lib/services/synced-objects/SyncedObjectsService', () => ({ SyncedObjectsService: { createObject: jest.fn() } }));
jest.mock('@/lib/services/email/EmailSendService', () => ({ EmailSendService: { applyInlineMarkdown: (s: string) => s, renderMessageWithLists: (s: string) => s } }));
import { AgentMailSendService } from '../../email/AgentMailSendService';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { sendMessage } from '@/lib/integrations/agentmail/agentmail-service';

test('managed AgentMail preserves durable dispatch marker before and after provider send', async () => {
  (sendMessage as jest.Mock).mockImplementation(async () => {
    expect(supabaseAdmin.from).not.toHaveBeenCalled();
    return { message_id: 'provider', thread_id: 'thread' };
  });
  await AgentMailSendService.sendViaAgentMail({ site_id: 'site', email: 'lead@example.com', subject: 'Hi', message: 'Hello', username: 'hi', domain: 'example.com', senderEmail: 'hi@example.com', trackingId: 'existing-message', preserveMessageMetadata: true });
  expect(supabaseAdmin.from).not.toHaveBeenCalled();
  expect(sendMessage).toHaveBeenCalledTimes(1);
});