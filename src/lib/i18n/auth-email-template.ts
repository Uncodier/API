import type { EmailLocale } from '@/lib/i18n/email-locale';
import { authActionKeys, authT } from '@/lib/i18n/email-messages/auth';
import { EMAIL_BRAND, emailBrandHeadTags, emailCodeBlock, emailCtaButton } from '@/lib/emails/brand';

function escapeHtml(text: string): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/`/g, '&#96;');
}

export interface AuthEmailTemplateInput {
  locale: EmailLocale;
  actionType: string;
  confirmUrl?: string;
  token?: string;
  siteName?: string;
}

/**
 * Auth email: B/W only on CTA + links; header/OTP use lime/gray surfaces.
 */
export function generateAuthEmailContent(input: AuthEmailTemplateInput): { subject: string; html: string } {
  const { locale, actionType, confirmUrl, token, siteName } = input;
  const keys = authActionKeys(actionType);
  const subject = authT(locale, keys.subject);
  const title = authT(locale, keys.title);
  const body = authT(locale, keys.body);
  const cta = authT(locale, keys.cta);
  const orEnterCode = authT(locale, 'auth.or_enter_code');
  const expires = authT(locale, 'auth.code_expires');
  const footer = authT(locale, 'auth.footer');

  const safeTitle = escapeHtml(title);
  const safeBody = escapeHtml(body);
  const safeCta = escapeHtml(cta);
  const safeOrCode = escapeHtml(orEnterCode);
  const safeExpires = escapeHtml(expires);
  const safeFooter = escapeHtml(footer);
  const safeSite = siteName ? escapeHtml(siteName) : '';
  const safeToken = token ? escapeHtml(token) : '';
  const safeUrl = confirmUrl ? escapeAttr(confirmUrl) : '';

  const linkBlock = confirmUrl
    ? `
      ${emailCtaButton(safeUrl, safeCta)}
      <p style="color:${EMAIL_BRAND.muted};font-size:13px;word-break:break-all;text-align:center;">${safeFooter}<br/><a class="email-link" href="${safeUrl}" style="color:${EMAIL_BRAND.link};word-break:break-all;">${escapeHtml(confirmUrl)}</a></p>
    `
    : '';

  const codeBlock = token ? emailCodeBlock(safeOrCode, safeToken) : '';

  const html = `
<!DOCTYPE html>
<html lang="${locale}">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  ${emailBrandHeadTags()}
</head>
<body style="margin:0;padding:0;background:${EMAIL_BRAND.bodyBg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div class="email-card" style="max-width:560px;margin:40px auto;background:${EMAIL_BRAND.cardBg};border-radius:12px;overflow:hidden;box-shadow:0 4px 6px rgba(30,30,45,0.08);">
    <div class="email-header" style="background:${EMAIL_BRAND.headerBg};padding:28px 32px;color:${EMAIL_BRAND.headerText};">
      <h1 class="email-header-title" style="margin:0;font-size:22px;color:${EMAIL_BRAND.headerText};">${safeTitle}</h1>
      ${safeSite ? `<p class="email-header-sub" style="margin:8px 0 0;font-size:14px;color:${EMAIL_BRAND.headerMuted};">${safeSite}</p>` : ''}
    </div>
    <div style="padding:32px;">
      <p class="email-text" style="margin:0 0 16px;color:${EMAIL_BRAND.text};font-size:16px;line-height:1.5;">${safeBody}</p>
      ${linkBlock}
      ${codeBlock}
      <p class="email-subtle" style="margin:24px 0 0;color:${EMAIL_BRAND.subtle};font-size:13px;">${safeExpires}</p>
    </div>
  </div>
</body>
</html>`;

  return { subject, html };
}

export function buildSupabaseConfirmUrl(params: {
  supabaseUrl: string;
  tokenHash: string;
  emailActionType: string;
  redirectTo?: string;
}): string {
  const base = params.supabaseUrl.replace(/\/$/, '');
  const url = new URL(`${base}/auth/v1/verify`);
  url.searchParams.set('token', params.tokenHash);
  url.searchParams.set('type', params.emailActionType);
  if (params.redirectTo) {
    url.searchParams.set('redirect_to', params.redirectTo);
  }
  return url.toString();
}
