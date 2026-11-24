import { GET, PATCH, POST } from '../route';
import { sendRoutedText } from '@/lib/services/whatsapp/routed-text';
import { readRoutedTextOutcome, stopRoutedTextPoll } from '@/lib/services/whatsapp/routed-text-recovery';
import { isInternalServiceRequest } from '@/lib/security/request-rate-limit';
jest.mock('@/lib/security/request-rate-limit', () => ({ isInternalServiceRequest: jest.fn() }));
jest.mock('@/lib/services/whatsapp/routed-text', () => ({ sendRoutedText: jest.fn() }));
jest.mock('@/lib/services/whatsapp/routed-text-recovery', () => ({ readRoutedTextOutcome: jest.fn(), stopRoutedTextPoll: jest.fn() }));
jest.mock('@/lib/services/channels/automation-send-guard', () => ({ AutomationSendSuppressed: class extends Error {} }));
const id = { site_id: '00000000-0000-4000-8000-000000000001', conversation_id: '00000000-0000-4000-8000-000000000002',
  message_id: '00000000-0000-4000-8000-000000000003' };
const post = (body: object) => POST(new Request('https://example.test/send', { method: 'POST', body: JSON.stringify(body) }));
beforeEach(() => { jest.resetAllMocks(); jest.mocked(isInternalServiceRequest).mockReturnValue(true); });
it('rejects non-worker calls even when the IDs are valid', async () => {
  jest.mocked(isInternalServiceRequest).mockReturnValue(false);
  expect((await post(id)).status).toBe(403);
  expect(sendRoutedText).not.toHaveBeenCalled();
});
it.each(['template_id', 'to', 'connection_id', 'text'])('never accepts a %s override', async key => {
  expect((await post({ ...id, [key]: 'override' })).status).toBe(400);
  expect(sendRoutedText).not.toHaveBeenCalled();
});
it('does not turn a storage conflict into permission to resend', async () => {
  jest.mocked(sendRoutedText).mockRejectedValue(new Error('CAS failed'));
  const res = await post(id);
  expect(res.status).toBe(503);
  expect(await res.json()).toMatchObject({ success: false, status: 'needs_reconciliation', message_id: id.message_id });
});

const binding = { connection_id: 'chosen', provider: 'zavu', template_id: 'tpl', attempt_id: '00000000-0000-4000-8000-000000000004' };
const get = () => GET(new Request(`https://example.test/send?${new URLSearchParams(id)}`));
const patch = (body: object) => PATCH(new Request('https://example.test/send', { method: 'PATCH', body: JSON.stringify(body) }));
it('provides a non-cached read and scoped CAS control operation, neither can dispatch', async () => {
  jest.mocked(readRoutedTextOutcome).mockResolvedValue({ ...id, status: 'failed', success: false });
  jest.mocked(stopRoutedTextPoll).mockResolvedValue({ ...id, status: 'needs_reconciliation', success: false, reconciliation_persisted: true });
  const res = await get();
  expect(res.headers.get('cache-control')).toContain('no-store');
  expect(await res.json()).toMatchObject({ message_id: id.message_id, status: 'failed' });
  expect((await patch(id)).status).toBe(400);
  expect((await patch({ ...id, ...binding, recipient: 'override' })).status).toBe(400);
  expect(await (await patch({ ...id, ...binding })).json()).toMatchObject({ reconciliation_persisted: true });
  expect(readRoutedTextOutcome).toHaveBeenCalledWith(id);
  expect(stopRoutedTextPoll).toHaveBeenCalledWith(id, binding);
  expect(sendRoutedText).not.toHaveBeenCalled();
});
it('blocks non-worker recovery and returns an unavailable read on DB outage', async () => {
  jest.mocked(isInternalServiceRequest).mockReturnValue(false);
  expect((await get()).status).toBe(403); expect((await patch({ ...id, ...binding })).status).toBe(403);
  expect(stopRoutedTextPoll).not.toHaveBeenCalled(); expect(readRoutedTextOutcome).not.toHaveBeenCalled();
  jest.mocked(isInternalServiceRequest).mockReturnValue(true);
  jest.mocked(readRoutedTextOutcome).mockRejectedValue(new Error('offline'));
  expect((await get()).status).toBe(503);
});