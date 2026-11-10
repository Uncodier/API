import { createZavuTemplate, getZavuTemplate, submitZavuTemplate, sendZavuTemplate } from '../templates';
import { zavuFetch } from '../client';
jest.mock('../client', () => ({ zavuFetch: jest.fn() }));
const template = { id: 'template', name: 'reply_test', body: 'Hola', language: 'es', status: 'draft' };
beforeEach(() => { jest.resetAllMocks(); jest.mocked(zavuFetch).mockResolvedValue(template); });
it('creates a literal template using the documented v1 schema', async () => {
  await createZavuTemplate({ name: template.name, body: template.body, language: 'es' });
  const [path, init] = jest.mocked(zavuFetch).mock.calls[0];
  expect(path).toBe('/templates');
  expect(JSON.parse(String(init?.body))).toEqual({ name: 'reply_test', body: 'Hola', language: 'es',
    whatsappCategory: 'UTILITY', variables: [] });
});
it('submits using the exact selected sender and retrieves only the saved template', async () => {
  await submitZavuTemplate('template', 'sender');
  expect(jest.mocked(zavuFetch).mock.calls[0][0]).toBe('/templates/template/submit');
  expect(JSON.parse(String(jest.mocked(zavuFetch).mock.calls[0][1]?.body))).toEqual({ senderId: 'sender', category: 'UTILITY' });
  await getZavuTemplate('template');
  expect(jest.mocked(zavuFetch).mock.calls[1][0]).toBe('/templates/template');
});
it('sends template content with sender pinning and idempotency', async () => {
  jest.mocked(zavuFetch).mockResolvedValue({ message: { id: 'provider', status: 'queued' } });
  expect(await sendZavuTemplate({ templateId: 'template', senderId: 'sender', to: '+15555550100', idempotencyKey: 'unique' })).toBe('provider');
  const [path, init, options] = jest.mocked(zavuFetch).mock.calls[0];
  expect(path).toBe('/messages'); expect(init?.headers).toEqual({ 'Zavu-Sender': 'sender' });
  expect(JSON.parse(String(init?.body))).toEqual({ to: '+15555550100', channel: 'whatsapp',
    messageType: 'template', content: { templateId: 'template' }, idempotencyKey: 'unique' });
  expect(options).toEqual({ acceptMessageReplay: true });
});
it.each([{ message: { id: 'failed', status: 'failed' } }, { success: false, message: { id: 'failed', status: 'sent' } }, {}])('rejects nonaccepted provider result %j', async result => {
  jest.mocked(zavuFetch).mockResolvedValue(result);
  await expect(sendZavuTemplate({ templateId: 'template', senderId: 'sender', to: '+15555550100', idempotencyKey: 'unique' })).rejects.toThrow('acceptance');
});