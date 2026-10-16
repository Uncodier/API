import { supabaseAdmin } from '@/lib/database/supabase-client';
import { resolveEmailLocale } from '@/lib/i18n/email-locale';
import { withAbortSignal } from '@/lib/utils/with-abort-signal';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));

beforeEach(() => jest.clearAllMocks());

it('returns the default when a locale query ignores abort and starts no later queries', async () => {
  const controller = new AbortController();
  const q: any = { select: jest.fn(), eq: jest.fn(), abortSignal: jest.fn(), maybeSingle: jest.fn().mockReturnValue(new Promise(() => {})) };
  for (const key of ['select', 'eq', 'abortSignal']) q[key].mockReturnValue(q);
  (supabaseAdmin.from as jest.Mock).mockReturnValue(q);
  const pending = resolveEmailLocale({ userId: 'user-1', siteId: 'site-1', signal: controller.signal });
  controller.abort();
  expect(await pending).toBe('en');
  expect(q.abortSignal).toHaveBeenCalledWith(controller.signal);
  expect(supabaseAdmin.from).toHaveBeenCalledTimes(1);
});

it('passes cancellation to each lookup while preserving locale precedence', async () => {
  const controller = new AbortController();
  const signals: AbortSignal[] = [];
  (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
    const q: any = { select: () => q, eq: () => q, abortSignal: (signal: AbortSignal) => { signals.push(signal); return q; },
      maybeSingle: async () => ({ data: table === 'settings' ? { default_locale: 'es' } : null, error: null }) };
    return q;
  });
  expect(await resolveEmailLocale({ userId: 'u', leadId: 'l', siteId: 's', signal: controller.signal })).toBe('es');
  expect(signals).toEqual([controller.signal, controller.signal, controller.signal]);
});

it('does not query for an explicit locale or expired budget', async () => {
  const controller = new AbortController(); controller.abort();
  expect(await resolveEmailLocale({ userId: 'u', signal: controller.signal })).toBe('en');
  expect(await resolveEmailLocale({ explicitLocale: 'fr', signal: controller.signal })).toBe('fr');
  expect(supabaseAdmin.from).not.toHaveBeenCalled();
});

it('removes abort listeners after either success or cancellation', async () => {
  const controller = new AbortController();
  const remove = jest.spyOn(controller.signal, 'removeEventListener');
  expect(await withAbortSignal(Promise.resolve('done'), controller.signal)).toBe('done');
  await Promise.resolve();
  expect(remove).toHaveBeenCalled();
  const pending = withAbortSignal(new Promise(() => {}), controller.signal);
  controller.abort();
  await expect(pending).rejects.toBe(controller.signal.reason);
  remove.mockRestore();
});
