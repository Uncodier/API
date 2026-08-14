jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn(),
  },
}));

import { supabaseAdmin } from '@/lib/database/supabase-client';
import { DEFAULT_TIMEZONE } from '../constants';
import { resolveClientTimezone, resolveUserTimezone } from '../resolveUserTimezone';

function mockFrom(handlers: Record<string, { data: unknown; error: unknown }>) {
  (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
    const result = handlers[table] ?? { data: null, error: null };
    return {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue(result),
    };
  });
}

describe('resolveClientTimezone', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reads profiles.timezone for the user', async () => {
    mockFrom({
      profiles: { data: { timezone: 'America/New_York' }, error: null },
    });
    await expect(resolveUserTimezone('11111111-1111-4111-8111-111111111111')).resolves.toBe(
      'America/New_York'
    );
  });

  it('falls back to the site owner timezone', async () => {
    mockFrom({
      sites: { data: { user_id: '22222222-2222-4222-8222-222222222222' }, error: null },
      profiles: { data: { timezone: 'Europe/Madrid' }, error: null },
    });
    await expect(
      resolveClientTimezone({ siteId: '33333333-3333-4333-8333-333333333333' })
    ).resolves.toBe('Europe/Madrid');
  });

  it('falls back to America/Mexico_City when nothing is stored', async () => {
    mockFrom({
      profiles: { data: null, error: null },
      sites: { data: null, error: null },
    });
    await expect(resolveClientTimezone({})).resolves.toBe(DEFAULT_TIMEZONE);
    await expect(resolveClientTimezone({ userId: 'not-a-uuid' })).resolves.toBe(DEFAULT_TIMEZONE);
  });

  it('rejects invalid IANA values', async () => {
    mockFrom({
      profiles: { data: { timezone: 'Not/A_Zone' }, error: null },
    });
    await expect(resolveUserTimezone('11111111-1111-4111-8111-111111111111')).resolves.toBe(
      DEFAULT_TIMEZONE
    );
  });
});
