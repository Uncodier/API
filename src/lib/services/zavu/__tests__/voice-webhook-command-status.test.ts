const mockFrom = jest.fn();
jest.mock('@/lib/database/supabase-server', () => ({
  supabaseAdmin: { from: mockFrom, schema: () => ({ from: mockFrom }) },
}));
jest.mock('../contact-client', () => ({ clearVoiceCallContactContext: jest.fn() }));
jest.mock('../voice-call-client', () => ({ getVoiceCall: jest.fn() }));
jest.mock('../inbound-voice-context', () => ({ handleUntrackedInboundVoiceEvent: jest.fn() }));
jest.mock('../voice-transcript', () => ({ persistVoiceTranscript: jest.fn() }));

import { handleVoiceCallEvent } from '../voice-webhook-handler';

it.each([
  ['call.ringing', 'ringing', 'sending', 'pending'],
  ['call.completed', 'completed', 'sent', 'success'],
  ['call.failed', 'no_answer', 'failed', 'failed'],
])('aligns message and command state for %s', async (type, callStatus, status, commandStatus) => {
  let messageUpdate: any;
  const delivery = { id: 'delivery', message_id: 'message', site_id: 'site', status: 'queued', recipient_phone: '+14155550100' };
  mockFrom.mockImplementation((table: string) => {
    let writing = false;
    const q: any = {
      select: () => q, limit: () => q, eq: () => q, not: () => q, neq: () => q,
      update: (payload: any) => { writing = true; if (table === 'messages') messageUpdate = payload; return q; },
      maybeSingle: async () => ({ data: writing ? { status: callStatus } : { custom_data: { command_status: 'pending' } }, error: null }),
      then: (resolve: any) => Promise.resolve(resolve({ data: writing ? null : [delivery], error: null })),
    };
    return q;
  });
  await handleVoiceCallEvent({ type, data: { callId: 'call', status: callStatus } });
  expect(messageUpdate.custom_data).toMatchObject({ status, command_status: commandStatus, call_status: callStatus });
});