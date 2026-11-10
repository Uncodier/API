import { deliverZavuTemplate } from '../zavu-template-delivery';
import { whatsappTemplateLanguage } from '../template-language';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { createZavuTemplate, getZavuTemplate, submitZavuTemplate, sendZavuTemplate } from '@/lib/services/zavu/templates';
import { requireLicensedChannel } from '@/lib/billing/licensed-resources';
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('@/lib/billing/licensed-resources', () => ({ requireLicensedChannel: jest.fn() }));
jest.mock('@/lib/services/zavu/templates', () => ({ createZavuTemplate: jest.fn(), getZavuTemplate: jest.fn(),
  submitZavuTemplate: jest.fn(), sendZavuTemplate: jest.fn() }));

const input = { siteId: 'site', conversationId: 'conversation', messageId: 'message', text: 'Hola Sergio, aquí está la información.',
  recipient: '+15555550100', connectionId: 'connection', senderId: 'sender' };
let row: any;
let remote: any;
let locale: unknown;
beforeEach(() => {
  jest.clearAllMocks();
  locale = 'es-MX';
  row = { role: 'team_member', content: input.text, custom_data: { response_format: 'audio', connection_id: 'connection' } };
  jest.mocked(supabaseAdmin.from).mockImplementation((table: string) => {
    let update: any;
    const filters: Record<string, any> = {};
    const q: any = { select: () => q, eq: (key: string, value: any) => { filters[key] = value; return q; },
      update: (value: any) => { update = value; return q; }, maybeSingle: async () => {
        if (table === 'settings') return { data: { default_locale: locale } };
        if (table === 'conversations') return { data: { id: 'conversation' } };
        if (!update) return { data: structuredClone(row) };
        if (filters.content !== row.content || filters.custom_data !== JSON.stringify(row.custom_data)) return { data: null };
        row.custom_data = update.custom_data;
        return { data: { id: 'message' } };
      } };
    return q;
  });
  jest.mocked(requireLicensedChannel).mockResolvedValue({});
  jest.mocked(createZavuTemplate).mockImplementation(async body => { remote = { ...body, id: 'template', status: 'draft' }; return remote; });
  jest.mocked(getZavuTemplate).mockImplementation(async () => remote);
  jest.mocked(submitZavuTemplate).mockImplementation(async () => { remote = { ...remote, status: 'pending' }; return remote; });
  jest.mocked(sendZavuTemplate).mockResolvedValue('provider');
});

it.each([['es-MX', 'es_MX'], ['en-US', 'en_US'], ['pt-BR', 'pt_BR'], ['fr-CA', 'fr'], [null, 'en']])('maps site language %s to %s', (value, expected) => {
  expect(whatsappTemplateLanguage(value)).toBe(expected);
});
it.each(['auto', 'internal', 'xx-XX', 2, 'es\nignore'])('rejects invalid stored language %s', value => {
  expect(() => whatsappTemplateLanguage(value)).toThrow();
});
it('submits once, reports pending, then sends one approved template without producing audio', async () => {
  expect(await deliverZavuTemplate(input)).toMatchObject({ template_pending: true, template_used: false,
    status: 'template_pending', message_id: 'message', delivery_format: 'template' });
  expect(createZavuTemplate).toHaveBeenCalledWith(expect.objectContaining({ language: 'es_MX', body: input.text }));
  expect(submitZavuTemplate).toHaveBeenCalledWith('template', 'sender');
  expect(sendZavuTemplate).not.toHaveBeenCalled();
  expect(row.custom_data).toMatchObject({ status: 'queued', response_format: 'audio', delivery_format: 'template' });
  expect(await deliverZavuTemplate(input)).toMatchObject({ template_pending: true });
  locale = 'en'; // Approval polling uses the persisted language, never a new template.
  remote.status = 'approved';
  expect(await deliverZavuTemplate(input)).toMatchObject({ status: 'sent', messageId: 'provider', template_used: true });
  expect(await deliverZavuTemplate(input)).toMatchObject({ messageId: 'provider' });
  expect(createZavuTemplate).toHaveBeenCalledTimes(1);
  expect(submitZavuTemplate).toHaveBeenCalledTimes(1);
  expect(sendZavuTemplate).toHaveBeenCalledTimes(1);
  expect(row.custom_data).toMatchObject({ status: 'queued', command_status: 'pending',
    template_delivery: { state: 'accepted', delivery_status: 'queued' } });
  expect(row.custom_data.audio_delivery).toBeUndefined();
  expect(row.custom_data.attachments).toBeUndefined();
});
it('surfaces a rejected template without retrying creation or sending text/audio', async () => {
  await deliverZavuTemplate(input); remote.status = 'rejected';
  await expect(deliverZavuTemplate(input)).rejects.toThrow('rejected');
  expect(row.custom_data.status).toBe('failed');
  expect(sendZavuTemplate).not.toHaveBeenCalled();
  expect(createZavuTemplate).toHaveBeenCalledTimes(1);
});
it('does not duplicate uncertain sends', async () => {
  await deliverZavuTemplate(input); remote.status = 'approved';
  jest.mocked(sendZavuTemplate).mockRejectedValue(new Error('timeout'));
  await expect(deliverZavuTemplate(input)).rejects.toThrow('unconfirmed');
  await expect(deliverZavuTemplate(input)).rejects.toThrow('unconfirmed');
  expect(sendZavuTemplate).toHaveBeenCalledTimes(1);
  expect(row.custom_data.status).toBe('placement_unknown');
});
it('does not recreate after uncertain creation', async () => {
  jest.mocked(createZavuTemplate).mockRejectedValue(new Error('timeout'));
  await expect(deliverZavuTemplate(input)).rejects.toThrow('unconfirmed');
  await expect(deliverZavuTemplate(input)).rejects.toThrow('unconfirmed');
  expect(createZavuTemplate).toHaveBeenCalledTimes(1);
});
it('lets only one concurrent owner create and submit', async () => {
  const results = await Promise.allSettled([deliverZavuTemplate(input), deliverZavuTemplate(input)]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(createZavuTemplate).toHaveBeenCalledTimes(1);
  expect(submitZavuTemplate).toHaveBeenCalledTimes(1);
});
it('rejects changes, oversized content and audio-owned messages before provider operations', async () => {
  await expect(deliverZavuTemplate({ ...input, text: 'Changed' })).rejects.toThrow('changed');
  row.content = 'a'.repeat(1025);
  await expect(deliverZavuTemplate({ ...input, text: row.content })).rejects.toThrow('1024');
  row.content = input.text; row.custom_data.audio_delivery = { state: 'dispatching' };
  await expect(deliverZavuTemplate(input)).rejects.toThrow('Audio already owns');
  expect(createZavuTemplate).not.toHaveBeenCalled();
});
it('refuses provider changes to the body or language and checks the selected sender at dispatch', async () => {
  await deliverZavuTemplate(input); remote.status = 'approved'; remote.body = 'Wrong';
  await expect(deliverZavuTemplate(input)).rejects.toThrow('changed');
  expect(sendZavuTemplate).not.toHaveBeenCalled();
});
it('handles read-only status outages as pending, never sent', async () => {
  await deliverZavuTemplate(input);
  jest.mocked(getZavuTemplate).mockRejectedValue(new Error('unavailable'));
  expect(await deliverZavuTemplate(input)).toMatchObject({ template_pending: true });
  expect(sendZavuTemplate).not.toHaveBeenCalled();
});
it('fails approval after 24 hours without dispatching', async () => {
  await deliverZavuTemplate(input);
  row.custom_data.template_delivery.started_at = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  await expect(deliverZavuTemplate(input)).rejects.toThrow('timed out');
  expect(row.custom_data.template_delivery.state).toBe('rejected');
  expect(row.custom_data.error_message).toContain('timed out');
  expect(sendZavuTemplate).not.toHaveBeenCalled();
});
it('checks the provider before timing out and delivers an approval discovered after the deadline', async () => {
  await deliverZavuTemplate(input);
  row.custom_data.template_delivery.started_at = new Date(Date.now() - 24.5 * 60 * 60 * 1000).toISOString();
  remote.status = 'approved';
  const reads = jest.mocked(getZavuTemplate).mock.calls.length;
  expect(await deliverZavuTemplate(input)).toMatchObject({ template_pending: false, messageId: 'provider' });
  expect(getZavuTemplate).toHaveBeenCalledTimes(reads + 1);
  expect(sendZavuTemplate).toHaveBeenCalledTimes(1);
  expect(row.custom_data.template_delivery.state).toBe('accepted');
});
it('does not falsely time out an approval when the final provider status read is unavailable', async () => {
  await deliverZavuTemplate(input);
  row.custom_data.template_delivery.started_at = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  jest.mocked(getZavuTemplate).mockRejectedValue(new Error('503'));
  expect(await deliverZavuTemplate(input)).toMatchObject({ template_pending: true });
  expect(row.custom_data.template_delivery.state).toBe('pending');
  expect(sendZavuTemplate).not.toHaveBeenCalled();
});
it('does not treat contradictory WhatsApp approval state as ready to send', async () => {
  await deliverZavuTemplate(input); remote.status = 'approved'; remote.whatsapp = { status: 'PENDING' };
  expect(await deliverZavuTemplate(input)).toMatchObject({ template_pending: true });
  expect(sendZavuTemplate).not.toHaveBeenCalled();
});
it('rechecks licensing before an approved template is dispatched', async () => {
  await deliverZavuTemplate(input); remote.status = 'approved';
  jest.mocked(requireLicensedChannel).mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('disabled'));
  await expect(deliverZavuTemplate(input)).rejects.toThrow('sender changed');
  expect(sendZavuTemplate).not.toHaveBeenCalled();
});
it('does not dispatch a template that has not been submitted to the pinned sender', async () => {
  await deliverZavuTemplate(input); remote.status = 'approved';
  row.custom_data.template_delivery.submitted_sender_id = 'other-sender';
  await expect(deliverZavuTemplate(input)).rejects.toThrow('not bound');
  expect(sendZavuTemplate).not.toHaveBeenCalled();
});