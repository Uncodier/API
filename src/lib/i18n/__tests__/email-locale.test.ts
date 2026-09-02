import { createHmac } from 'crypto';
import {
  DEFAULT_EMAIL_LOCALE,
  isEmailLocale,
  normalizeEmailLocale,
  tryNormalizeEmailLocale,
} from '@/lib/i18n/email-locale';
import { generateAuthEmailContent, buildSupabaseConfirmUrl } from '@/lib/i18n/auth-email-template';
import { verifyStandardWebhook } from '@/lib/i18n/standard-webhook';
import { platformT } from '@/lib/i18n/email-messages/platform';
import { authT } from '@/lib/i18n/email-messages/auth';

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn(),
  },
}));

import { supabaseAdmin } from '@/lib/database/supabase-client';
import { resolveEmailLocale, getSiteDefaultLocale } from '@/lib/i18n/email-locale';

function mockFromChain(result: { data: any; error: any }) {
  const chain: any = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue(result),
    single: jest.fn().mockResolvedValue(result),
  };
  (supabaseAdmin.from as jest.Mock).mockReturnValue(chain);
  return chain;
}

describe('email locale helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('normalizes and validates locales', () => {
    expect(isEmailLocale('en')).toBe(true);
    expect(isEmailLocale('ja')).toBe(true);
    expect(isEmailLocale('pt')).toBe(false);
    expect(normalizeEmailLocale('ES-MX')).toBe('es');
    expect(tryNormalizeEmailLocale('nope')).toBeNull();
    expect(normalizeEmailLocale('nope')).toBe(DEFAULT_EMAIL_LOCALE);
  });

  it('resolveEmailLocale prefers user language over site default', async () => {
    (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
      const chain: any = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn().mockResolvedValue(
          table === 'profiles'
            ? { data: { language: 'fr' }, error: null }
            : { data: { default_locale: 'es' }, error: null }
        ),
      };
      return chain;
    });

    const locale = await resolveEmailLocale({
      siteId: 'site-1',
      userId: 'user-1',
    });
    expect(locale).toBe('fr');
  });

  it('resolveEmailLocale falls back to site default_locale', async () => {
    (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
      const chain: any = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn().mockResolvedValue(
          table === 'settings'
            ? { data: { default_locale: 'de' }, error: null }
            : { data: null, error: null }
        ),
      };
      return chain;
    });

    const locale = await resolveEmailLocale({ siteId: 'site-1' });
    expect(locale).toBe('de');
  });

  it('resolveEmailLocale uses lead language when present', async () => {
    (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
      const chain: any = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn().mockResolvedValue(
          table === 'leads'
            ? { data: { language: 'ja' }, error: null }
            : { data: { default_locale: 'en' }, error: null }
        ),
      };
      return chain;
    });

    const locale = await resolveEmailLocale({ siteId: 'site-1', leadId: 'lead-1' });
    expect(locale).toBe('ja');
  });

  it('getSiteDefaultLocale returns null when missing', async () => {
    mockFromChain({ data: null, error: null });
    await expect(getSiteDefaultLocale('site-x')).resolves.toBeNull();
  });
});

describe('platform and auth catalogs', () => {
  it('falls back to English for missing keys', () => {
    expect(platformT('es', 'invite.cta')).toBeTruthy();
    expect(authT('ja', 'auth.magiclink.subject')).toBeTruthy();
    expect(platformT('en', 'missing.key.that.does.not.exist')).toBe('missing.key.that.does.not.exist');
  });
});

describe('auth email template', () => {
  it('includes both magic link and visible OTP code for old tests but correctly formats link', () => {
    const { subject, html, text } = generateAuthEmailContent({
      locale: 'es',
      actionType: 'magiclink',
      channel: 'link',
      confirmUrl: 'https://example.supabase.co/auth/confirm?token_hash=abc&type=magiclink',
      token: '305805',
    });

    expect(subject).toMatch(/acceso|sign-in|connexion|Anmelde|サインイン/i);
    // As per new rules, link channel doesn't have the code
    expect(html).not.toContain('305805');
    expect(html).toContain('auth/confirm');
    expect(text).toContain('auth/confirm');
    expect(html).toContain('class="email-cta"');
    expect(html).not.toContain('class="email-code-box"');
    expect(html).toContain('class="email-header"');
    expect(html).toContain('#1e1e2d');
    expect(html).toContain('#f0f0f5');
    expect(html).toContain('linear-gradient');
    expect(html).toContain('box-shadow:inset 0 0 0 999px');
    expect(html).toContain('color-scheme: light only');
    expect(html).toContain('-webkit-text-fill-color');
  });

  it('includes only code block for OTP channel', () => {
    const { subject, html, text } = generateAuthEmailContent({
      locale: 'es',
      actionType: 'magiclink',
      channel: 'otp',
      confirmUrl: 'https://example.supabase.co/auth/confirm?token_hash=abc&type=magiclink',
      token: '305805',
    });

    expect(subject).toMatch(/código|code|Code|コード/i);
    expect(html).toContain('305805');
    expect(html).toContain('es tu código de verificación.');
    expect(html).not.toMatch(/305805 es tu código[\s\S]*305805 es tu código/);
    expect(text).toContain('305805');
    expect(text).toContain('305805 es tu código de verificación.');
    expect(html).not.toContain('auth/confirm');
    expect(html).not.toContain('class="email-cta"');
    expect(html).toContain('class="email-code-box"');
    expect(html).not.toContain('letter-spacing:0.35em');
  });

  it('builds supabase confirm URL', () => {
    const url = buildSupabaseConfirmUrl({
      supabaseUrl: 'https://proj.supabase.co',
      tokenHash: 'hash123',
      emailActionType: 'magiclink',
      redirectTo: 'https://app.example.com',
      siteUrl: 'https://app.example.com',
    });
    expect(url).toContain('token_hash=hash123');
    expect(url).toContain('type=magiclink');
    expect(url).toContain('redirect_to=');
    expect(url).toContain('https://app.example.com/auth/confirm');
  });
});

describe('standard webhook verification', () => {
  it('accepts a valid signature', () => {
    const secretBytes = Buffer.from('super-secret-key-for-tests!!');
    const secret = `v1,whsec_${secretBytes.toString('base64')}`;
    const body = JSON.stringify({ hello: 'world' });
    const msgId = 'msg_123';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const toSign = `${msgId}.${timestamp}.${body}`;
    const sig = createHmac('sha256', secretBytes).update(toSign).digest('base64');

    const result = verifyStandardWebhook({
      body,
      secret,
      headers: {
        'webhook-id': msgId,
        'webhook-timestamp': timestamp,
        'webhook-signature': `v1,${sig}`,
      },
    });

    expect(result.ok).toBe(true);
  });

  it('rejects invalid signature', () => {
    const result = verifyStandardWebhook({
      body: '{}',
      secret: 'v1,whsec_YWJjZA==',
      headers: {
        'webhook-id': 'msg_1',
        'webhook-timestamp': String(Math.floor(Date.now() / 1000)),
        'webhook-signature': 'v1,invalid',
      },
    });
    expect(result.ok).toBe(false);
  });
});
