jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: { schema: jest.fn() },
}));
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { getSupportLanguagePolicy } from '../support-language';

const schema = jest.mocked(supabaseAdmin.schema);
const maybeSingle = jest.fn();
const eq = jest.fn(() => ({ maybeSingle }));
const select = jest.fn(() => ({ eq }));
const from = jest.fn(() => ({ select }));

describe('support language policy and deterministic fallback loading', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    schema.mockReturnValue({ from } as any);
    maybeSingle.mockResolvedValue({ data: { default_locale: 'ja' }, error: null });
  });

  it('states ordered spoken/written priority and customer-only prompt inference', async () => {
    const policy = await getSupportLanguagePolicy({});
    const priorities = ['1. Explicitly requested customer language', '2. Current conversation language',
      '3. Lead language preference', '4. Site language'];
    priorities.forEach((text, index) => {
      expect(policy).toContain(text);
      if (index) expect(policy.indexOf(text)).toBeGreaterThan(policy.indexOf(priorities[index - 1]));
    });
    expect(policy).toContain('written response and spoken/audio response');
    expect(policy).toContain('current customer text and available customer audio transcripts');
    expect(policy).toContain('recent user/visitor messages and their transcripts');
    expect(policy).toContain('Do not infer it from assistant, team member, or system text');
    expect(policy).toContain('HTTP Accept-Language is transport metadata, never evidence');
    expect(policy).toContain('ambiguous short message or unavailable transcript');
    expect(policy).toContain('fallback language: "en"; source: default');
    expect(schema).not.toHaveBeenCalled();
  });

  it('uses the loaded lead preference before site without another database read', async () => {
    const policy = await getSupportLanguagePolicy({ siteId: 'site-1', leadLanguage: ' pt-BR ' });
    expect(policy).toContain('fallback language: "pt-BR"; source: lead preference');
    expect(schema).not.toHaveBeenCalled();
  });

  it.each([undefined, null, '', 'unknown', 'internal', 42, {}])('loads site for missing/invalid lead preference %p', async leadLanguage => {
    const policy = await getSupportLanguagePolicy({ siteId: 'effective-site', leadLanguage });
    expect(schema).toHaveBeenCalledWith(process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA || 'public');
    expect(from).toHaveBeenCalledWith('settings');
    expect(select).toHaveBeenCalledWith('default_locale');
    expect(eq).toHaveBeenCalledWith('site_id', 'effective-site');
    expect(policy).toContain('fallback language: "ja"; source: site language');
  });

  it.each([
    { data: null, error: null },
    { data: { default_locale: 'unknown' }, error: null },
    { data: { default_locale: 'fr' }, error: { message: 'unavailable' } },
  ])('defaults safely when settings are missing or unavailable: %p', async result => {
    maybeSingle.mockResolvedValue(result);
    expect(await getSupportLanguagePolicy({ siteId: 'site-1' })).toContain('fallback language: "en"; source: default');
  });

  it('defaults safely on a thrown settings lookup failure', async () => {
    maybeSingle.mockRejectedValue(new Error('offline'));
    expect(await getSupportLanguagePolicy({ siteId: 'site-1' })).toContain('fallback language: "en"; source: default');
  });
});
