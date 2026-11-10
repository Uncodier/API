jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('@/lib/security/site-access', () => ({ canAccessSite: jest.fn() }));
import { GET, POST } from '../route';
import { canAccessSite } from '@/lib/security/site-access';
import { supabaseAdmin } from '@/lib/database/supabase-client';
const id = '11111111-1111-4111-8111-111111111111';
const request = () => new Request(`https://api.example.test/api/agents/tools/templateDeliveryStatus?site_id=${id}&conversation_id=${id}&message_id=${id}`);
let metadata: any;
let dbError: boolean;
let writes: number;
beforeEach(() => {
  jest.clearAllMocks(); dbError = false; writes = 0;
  metadata = { template_delivery: { state: 'pending', template_id: 'template' } };
  jest.mocked(canAccessSite).mockResolvedValue(true);
  jest.mocked(supabaseAdmin.from).mockImplementation((table: string) => {
    let update: any;
    const q: any = { select: () => q, eq: () => q, update: (value: any) => { update = value; return q; },
      maybeSingle: async () => {
        if (dbError) return { error: {} };
        if (update) { writes++; metadata = update.custom_data; return { data: { id } }; }
        return { data: table === 'conversations' ? { id } : { role: 'team_member', custom_data: metadata } };
      } };
    return q;
  });
});
const markRequest = () => new Request('https://api.example.test/api/agents/tools/templateDeliveryStatus', {
  method: 'POST', body: JSON.stringify({ site_id: id, conversation_id: id, message_id: id, template_id: 'template', action: 'mark_reconciliation_required' }),
});
it('persists a stopped poller as needing reconciliation without changing its receipt', async () => {
  const receipt = structuredClone(metadata.template_delivery);
  expect((await POST(markRequest())).status).toBe(200);
  expect(metadata).toMatchObject({ status: 'needs_reconciliation', needs_reconciliation: true, template_delivery: receipt });
  expect(writes).toBe(1);
});
it.each(['accepted', 'sent', 'failed', 'unknown', 'dispatching'])('does not overwrite advanced state %s with polling outage', async state => {
  metadata.template_delivery.state = state;
  expect((await POST(markRequest())).status).toBe(200);
  expect(writes).toBe(0);
});
it.each(['ready', 'pending'])('permits resumption only for safe state %s', async state => {
  metadata.template_delivery.state = state;
  expect(await (await GET(request())).json()).toMatchObject({ success: true, recovery_action: 'resume', local_message_id: id,
    message_id: id, status: 'template_pending', template_pending: true });
});
it.each(['creating', 'submitting', 'dispatching', 'unknown', 'failed', 'rejected'])('does not authorize another send for %s', async state => {
  metadata.template_delivery.state = state;
  expect(await (await GET(request())).json()).toMatchObject({ recovery_action: 'stop' });
});
it.each(['accepted', 'sent', 'delivered', 'read'])('recognizes persisted acceptance or delivery %s without sending again', async state => {
  metadata.template_delivery = { state, template_id: 'template', provider_message_id: 'provider' };
  expect(await (await GET(request())).json()).toMatchObject({ recovery_action: 'complete', messageId: 'provider', local_message_id: id });
});
it('checks site authorization and returns retryable unavailability for failed reads', async () => {
  jest.mocked(canAccessSite).mockResolvedValue(false);
  expect((await GET(request())).status).toBe(403);
  expect(supabaseAdmin.from).not.toHaveBeenCalled();
  jest.mocked(canAccessSite).mockResolvedValue(true); dbError = true;
  expect((await GET(request())).status).toBe(503);
});
it('never reports failed receipt as complete or resumes an audio-owned message', async () => {
  metadata.status = 'failed'; metadata.template_delivery = { state: 'sent', provider_message_id: 'provider' };
  expect(await (await GET(request())).json()).toMatchObject({ recovery_action: 'stop' });
  metadata = { template_delivery: { state: 'pending', template_id: 'template' }, audio_delivery: { state: 'dispatching' } };
  expect(await (await GET(request())).json()).toMatchObject({ recovery_action: 'stop' });
});