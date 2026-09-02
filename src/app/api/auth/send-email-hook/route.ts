import { NextRequest, NextResponse } from 'next/server';
import { sendGridService } from '@/lib/services/sendgrid-service';
import { resolveEmailLocale, tryNormalizeEmailLocale } from '@/lib/i18n/email-locale';
import { buildSupabaseConfirmUrl, generateAuthEmailContent } from '@/lib/i18n/auth-email-template';
import { verifyStandardWebhook } from '@/lib/i18n/standard-webhook';
import { resolveAuthEmailChannel } from '@/lib/i18n/auth-email-channel';

export const runtime = 'nodejs';

interface AuthHookUser {
  id?: string;
  email?: string;
  new_email?: string;
  user_metadata?: Record<string, unknown>;
}

interface AuthHookEmailData {
  token?: string;
  token_hash?: string;
  redirect_to?: string;
  email_action_type?: string;
  site_url?: string;
  token_new?: string;
  token_hash_new?: string;
}

/**
 * Supabase Auth Send Email Hook.
 * Configure in Dashboard → Auth → Hooks → Send Email (HTTPS).
 * Env: SEND_EMAIL_HOOK_SECRET=v1,whsec_...
 *
 * Shop OTP emails include only the 6-digit code. App emails include only a confirm link.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.SEND_EMAIL_HOOK_SECRET;
  if (!secret) {
    console.error('[auth/send-email-hook] SEND_EMAIL_HOOK_SECRET is not configured');
    return NextResponse.json({ error: 'Hook secret not configured' }, { status: 500 });
  }

  const body = await request.text();
  const verified = verifyStandardWebhook({
    body,
    headers: request.headers,
    secret,
  });

  if (!verified.ok) {
    console.warn('[auth/send-email-hook] Signature verification failed:', verified.error);
    return NextResponse.json({ error: verified.error }, { status: 401 });
  }

  let payload: { user?: AuthHookUser; email_data?: AuthHookEmailData };
  try {
    payload = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  const user = payload.user || {};
  const emailData = payload.email_data || {};
  const actionType = emailData.email_action_type || 'magiclink';
  const channel = resolveAuthEmailChannel({
    redirect_to: emailData.redirect_to,
    email_action_type: actionType,
  });

  const metadata = user.user_metadata || {};
  const siteId =
    (typeof metadata.site_id === 'string' && metadata.site_id) ||
    (typeof metadata.siteId === 'string' && metadata.siteId) ||
    null;
  const explicitLocale =
    (typeof metadata.locale === 'string' && metadata.locale) ||
    (typeof metadata.i18n === 'string' && metadata.i18n) ||
    (typeof metadata.language === 'string' && metadata.language) ||
    null;

  const locale = await resolveEmailLocale({
    siteId,
    userId: user.id,
    explicitLocale,
  });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || emailData.site_url || '';

  const sendOne = async (opts: {
    to: string;
    token?: string;
    tokenHash?: string;
  }) => {
    if (!opts.to) return { success: false, error: 'Missing recipient' };

    const confirmUrl =
      opts.tokenHash && supabaseUrl && channel === 'link'
        ? buildSupabaseConfirmUrl({
            supabaseUrl,
            tokenHash: opts.tokenHash,
            emailActionType: actionType,
            redirectTo: emailData.redirect_to,
            siteUrl: emailData.site_url,
          })
        : undefined;

    const { subject, html, text } = generateAuthEmailContent({
      locale,
      actionType,
      channel,
      confirmUrl,
      token: opts.token,
      siteName: typeof metadata.site_name === 'string' ? metadata.site_name : undefined,
      userEmail: opts.to,
    });

    return sendGridService.sendEmail({
      to: opts.to,
      subject,
      html,
      text,
      categories: ['auth', 'supabase-auth-hook', actionType],
      customArgs: {
        authAction: actionType,
        locale: tryNormalizeEmailLocale(locale) || locale,
        userId: user.id || '',
      },
    });
  };

  try {
    // Secure email change can require two emails
    if (actionType === 'email_change' && emailData.token_hash_new && user.email) {
      const currentResult = await sendOne({
        to: user.email,
        token: emailData.token,
        tokenHash: emailData.token_hash_new,
      });
      if (!currentResult.success) {
        return NextResponse.json({ error: currentResult.error || 'Failed to send email' }, { status: 500 });
      }

      if (user.new_email) {
        const newResult = await sendOne({
          to: user.new_email,
          token: emailData.token_new || emailData.token,
          tokenHash: emailData.token_hash,
        });
        if (!newResult.success) {
          return NextResponse.json({ error: newResult.error || 'Failed to send email' }, { status: 500 });
        }
      }

      return NextResponse.json({});
    }

    const to = user.email || user.new_email;
    if (!to) {
      return NextResponse.json({ error: 'Missing user email' }, { status: 400 });
    }

    const result = await sendOne({
      to,
      token: emailData.token || emailData.token_new,
      tokenHash: emailData.token_hash || emailData.token_hash_new,
    });

    if (!result.success) {
      console.error('[auth/send-email-hook] SendGrid error:', result.error);
      return NextResponse.json({ error: result.error || 'Failed to send email' }, { status: 500 });
    }

    return NextResponse.json({});
  } catch (err: any) {
    console.error('[auth/send-email-hook] Unexpected error:', err);
    return NextResponse.json({ error: err?.message || 'Internal error' }, { status: 500 });
  }
}
