import { NextRequest, NextResponse } from 'next/server';
import { sendGridService } from '@/lib/services/sendgrid-service';
import { DEFAULT_EMAIL_LOCALE, resolveEmailLocale, tryNormalizeEmailLocale } from '@/lib/i18n/email-locale';
import { buildSupabaseConfirmUrl, generateAuthEmailContent } from '@/lib/i18n/auth-email-template';
import { verifyStandardWebhook } from '@/lib/i18n/standard-webhook';
import { resolveAuthEmailChannel } from '@/lib/i18n/auth-email-channel';
import { resolveTeamInvitationContext } from '@/lib/i18n/team-invitation-context';
import { createHash } from 'node:crypto';
import { withAbortSignal } from '@/lib/utils/with-abort-signal';
import { getTransactionalEmailProvider } from '@/lib/services/email/transactional-email-config';

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
  // Bound the entire hook, including body/locale resolution and either provider.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error('Auth email deadline exceeded')), 4_000);
  try {
    return await withAbortSignal(handleAuthEmail(request, deadline.signal), deadline.signal);
  } catch {
    console.error('[auth/send-email-hook] Email processing failed or exceeded its deadline');
    return NextResponse.json({ error: { http_code: 500, message: 'Internal email processing error' } }, { status: 500 });
  } finally {
    clearTimeout(timer);
    deadline.abort();
  }
}

async function handleAuthEmail(request: NextRequest, signal: AbortSignal) {
  const secret = process.env.SEND_EMAIL_HOOK_SECRET;
  if (!secret) {
    console.error('[auth/send-email-hook] SEND_EMAIL_HOOK_SECRET is not configured');
    return NextResponse.json({ error: 'Hook secret not configured' }, { status: 500 });
  }

  const body = await request.text();
  signal.throwIfAborted();
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
  const teamInvitation = resolveTeamInvitationContext(emailData.redirect_to, metadata);
  const siteId =
    (typeof metadata.site_id === 'string' && metadata.site_id) ||
    (typeof metadata.siteId === 'string' && metadata.siteId) ||
    null;
  const explicitLocale =
    (typeof metadata.locale === 'string' && metadata.locale) ||
    (typeof metadata.i18n === 'string' && metadata.i18n) ||
    (typeof metadata.language === 'string' && metadata.language) ||
    null;

  // Locale is enrichment, not a reason to delay an OTP. Leave most of the
  // four-second budget for sender validation and provider acceptance.
  const localeDeadline = new AbortController();
  const localeSignal = AbortSignal.any([signal, localeDeadline.signal]);
  const localeTimer = setTimeout(() => localeDeadline.abort(), 500);
  let locale = tryNormalizeEmailLocale(explicitLocale) || DEFAULT_EMAIL_LOCALE;
  try {
    locale = await withAbortSignal(resolveEmailLocale({
      siteId, userId: user.id, explicitLocale, signal: localeSignal,
    }), localeSignal);
  } catch { /* Keep the default locale when enrichment is unavailable. */ }
  finally { clearTimeout(localeTimer); localeDeadline.abort(); }
  signal.throwIfAborted();

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || emailData.site_url || '';

  const sendOne = async (opts: {
    to: string;
    token?: string;
    tokenHash?: string;
  }) => {
    if (!opts.to) return { success: false, error: 'Missing recipient' };
    signal.throwIfAborted();

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
      siteName:
        teamInvitation?.siteName ||
        (typeof metadata.site_name === 'string' ? metadata.site_name : undefined) ||
        (typeof metadata.siteName === 'string' ? metadata.siteName : undefined),
      teamInvitation,
      userEmail: opts.to,
    });

    return sendGridService.sendEmail({
      to: opts.to,
      subject,
      html,
      text,
      signal,
      idempotencyKey: `auth-${createHash('sha256').update(JSON.stringify({
        webhookId: request.headers.get('webhook-id'), actionType,
        recipient: opts.to, token: opts.token, tokenHash: opts.tokenHash,
      })).digest('hex')}`,
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
      const results = await Promise.all([
        sendOne({ to: user.email, token: emailData.token, tokenHash: emailData.token_hash_new }),
        ...(user.new_email ? [sendOne({
          to: user.new_email, token: emailData.token_new || emailData.token, tokenHash: emailData.token_hash,
        })] : []),
      ]);
      if (results.some(result => !result.success)) {
        for (const result of results) {
          if (!result.success && 'diagnostic' in result) console.error('[auth/send-email-hook] Transactional email send failed', {
            provider: getTransactionalEmailProvider(), action: 'email_change', ...result.diagnostic,
          });
        }
        return NextResponse.json({ error: { http_code: 500, message: 'Failed to send authentication email' } }, { status: 500 });
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
      // Safe diagnostics identify configuration/validation failures before any
      // provider call. Never print recipient, tokens, body or raw error strings.
      let provider: string = 'invalid';
      try { provider = getTransactionalEmailProvider(); } catch { /* bounded label */ }
      console.error('[auth/send-email-hook] Transactional email send failed', {
        provider, action: actionType === 'recovery' ? 'recovery' : 'other',
        ...(result.diagnostic || { stage: 'dispatch', code: 'unclassified_failure' }),
      });
      return NextResponse.json({ error: { http_code: 500, message: 'Failed to send authentication email' } }, { status: 500 });
    }

    return NextResponse.json({});
  } catch (err: any) {
    console.error('[auth/send-email-hook] Unexpected email processing error');
    return NextResponse.json({ error: { http_code: 500, message: 'Internal email processing error' } }, { status: 500 });
  }
}
