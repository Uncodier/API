import { resolveWhatsAppReplyContext } from '../reply-context';
import { supabaseAdmin } from '@/lib/database/supabase-client';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));

function setup(data: any, error: any = null) {
  const query: any = {};
  for (const method of ['select', 'eq', 'contains', 'order', 'limit']) query[method] = jest.fn().mockReturnValue(query);
  query.maybeSingle = jest.fn().mockResolvedValue({ data, error });
  (supabaseAdmin.from as jest.Mock).mockReturnValue(query);
  return query;
}

beforeEach(() => jest.clearAllMocks());

it('retrieves only the exact quoted message within the authorized instance/site/user', async () => {
  const message = '[Archivo adjunto - image/png]: https://example.invalid/old-image.png';
  const query = setup({ id: 'quoted-action', message, details: { message_sid: 'old-message' } });
  const text = await resolveWhatsAppReplyContext('instance', 'site', 'user', 'old-message');
  expect(query.eq.mock.calls).toEqual([
    ['instance_id', 'instance'], ['site_id', 'site'], ['user_id', 'user'],
    ['log_type', 'user_action'], ['trusted_user_action', true],
  ]);
  expect(query.contains).toHaveBeenCalledWith('details', { message_sid: 'old-message' });
  expect(text).toContain('[WhatsApp reply target: old-message]');
  expect(text).toContain(JSON.stringify(message));
});

it.each([null, { message: 'Foreign image', details: { message_sid: 'other-message' } }])(
  'does not silently substitute a recent or foreign image when the quote is unavailable: %j', async data => {
    setup(data);
    const text = await resolveWhatsAppReplyContext('instance', 'site', 'user', 'missing-message');
    expect(text).toContain('Do not guess a different image');
    expect(text).not.toContain('Foreign image');
  },
);

it('does no database lookup for an unquoted message', async () => {
  expect(await resolveWhatsAppReplyContext('instance', 'site', 'user')).toBe('');
  expect(supabaseAdmin.from).not.toHaveBeenCalled();
});