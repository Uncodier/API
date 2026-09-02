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
  channel: 'otp' | 'link';
  confirmUrl?: string;
  token?: string;
  siteName?: string;
  userEmail?: string;
}

/**
 * Auth email: B/W only on CTA + links; header/OTP use lime/gray surfaces.
 */
export function generateAuthEmailContent(input: AuthEmailTemplateInput): { subject: string; html: string } {
  const { locale, actionType, confirmUrl, token, siteName, userEmail } = input;
  
  if (actionType === 'recovery') {
    const subject = authT(locale, 'auth.recovery.subject');
    const title = authT(locale, 'auth.recovery.title');
    const subtitle = authT(locale, 'auth.recovery.subtitle');
    const bodyTitle = authT(locale, 'auth.recovery.body_title');
    const body = authT(locale, 'auth.recovery.body');
    const cta = authT(locale, 'auth.recovery.cta');
    
    const panelTitle = authT(locale, 'auth.recovery.panel_title');
    const emailLabel = authT(locale, 'auth.recovery.email_label');
    const timeLabel = authT(locale, 'auth.recovery.time_label');
    const timeValue = authT(locale, 'auth.recovery.time_value');
    const actionLabel = authT(locale, 'auth.recovery.action_label');
    const actionValue = authT(locale, 'auth.recovery.action_value');
    
    const instructionsTitle = authT(locale, 'auth.recovery.instructions_title');
    const i1 = authT(locale, 'auth.recovery.instruction_1');
    const i2 = authT(locale, 'auth.recovery.instruction_2');
    const i3 = authT(locale, 'auth.recovery.instruction_3');
    const i4 = authT(locale, 'auth.recovery.instruction_4');
    
    const securityNoticeTitle = authT(locale, 'auth.recovery.security_notice_title');
    const securityNotice = authT(locale, 'auth.recovery.security_notice');

    const safeUrl = confirmUrl ? escapeAttr(confirmUrl) : '';
    const safeUserEmail = userEmail ? escapeHtml(userEmail) : '';

    const linkBlock = confirmUrl ? emailCtaButton(safeUrl, escapeHtml(cta)) : '';
    const codeBlock = (token && input.channel === 'otp') ? emailCodeBlock(escapeHtml(authT(locale, 'auth.or_enter_code')), escapeHtml(token)) : '';

    const html = `
<!DOCTYPE html>
<html lang="${locale}">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  ${emailBrandHeadTags()}
</head>
<body style="margin:0;padding:0;background:${EMAIL_BRAND.bodyBg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div class="email-card" style="max-width:560px;margin:40px auto;background:${EMAIL_BRAND.cardBg};border-radius:12px;overflow:hidden;box-shadow:0 4px 6px rgba(30,30,45,0.08);">
    <div class="email-header" style="background:${EMAIL_BRAND.headerBg};padding:28px 32px;color:${EMAIL_BRAND.headerText};text-align:center;">
      <h1 class="email-header-title" style="margin:0;font-size:22px;color:${EMAIL_BRAND.headerText};">${escapeHtml(title)}</h1>
      <p class="email-header-sub" style="margin:8px 0 0;font-size:14px;color:${EMAIL_BRAND.headerMuted};">${escapeHtml(subtitle)}</p>
    </div>
    <div style="padding:32px;">
      <h2 class="email-heading" style="margin:0 0 16px;font-size:18px;text-align:center;color:${EMAIL_BRAND.text};">${escapeHtml(bodyTitle)}</h2>
      <p class="email-text" style="margin:0 0 24px;color:${EMAIL_BRAND.text};font-size:15px;line-height:1.6;text-align:center;">${escapeHtml(body)}</p>
      
      <div class="email-panel" style="background-color:${EMAIL_BRAND.panelBg};background-image:linear-gradient(${EMAIL_BRAND.panelBg},${EMAIL_BRAND.panelBg});padding:24px;border-radius:8px;border:1px solid ${EMAIL_BRAND.panelBorder};margin-bottom:32px;">
        <h3 class="email-heading" style="margin:0 0 16px;font-size:15px;color:${EMAIL_BRAND.text};">${escapeHtml(panelTitle)}</h3>
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="font-size:14px;">
          ${safeUserEmail ? `<tr>
            <td width="130" style="padding-bottom:12px;color:${EMAIL_BRAND.muted};font-size:13px;">${escapeHtml(emailLabel)}</td>
            <td style="padding-bottom:12px;"><a href="mailto:${safeUserEmail}" class="email-link" style="color:${EMAIL_BRAND.link};text-decoration:none;">${safeUserEmail}</a></td>
          </tr>` : ''}
          <tr>
            <td width="130" style="padding-bottom:12px;color:${EMAIL_BRAND.muted};font-size:13px;">${escapeHtml(timeLabel)}</td>
            <td style="padding-bottom:12px;color:${EMAIL_BRAND.text};">${escapeHtml(timeValue)}</td>
          </tr>
          <tr>
            <td width="130" style="color:${EMAIL_BRAND.muted};font-size:13px;">${escapeHtml(actionLabel)}</td>
            <td style="color:${EMAIL_BRAND.text};font-weight:600;"><span style="color:#d97706;">${escapeHtml(actionValue)}</span></td>
          </tr>
        </table>
      </div>

      <h3 class="email-heading" style="margin:0 0 16px;font-size:15px;color:${EMAIL_BRAND.text};">${escapeHtml(instructionsTitle)}</h3>
      <ul style="margin:0 0 32px;padding-left:20px;color:${EMAIL_BRAND.text};font-size:14px;line-height:1.6;">
        <li style="margin-bottom:8px;">${escapeHtml(i1)}</li>
        <li style="margin-bottom:8px;">${escapeHtml(i2)}</li>
        <li style="margin-bottom:8px;">${escapeHtml(i3)}</li>
        <li>${escapeHtml(i4)}</li>
      </ul>

      ${linkBlock}
      ${codeBlock}

      <div style="margin-top:32px;padding-top:24px;border-top:1px solid ${EMAIL_BRAND.surfaceBorder};">
        <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:${EMAIL_BRAND.muted};">
          🛡️ ${escapeHtml(securityNoticeTitle)}
        </p>
        <p style="margin:0;font-size:12px;color:${EMAIL_BRAND.subtle};line-height:1.5;">
          ${escapeHtml(securityNotice)}
        </p>
      </div>
    </div>
  </div>
</body>
</html>`;

    return { subject, html };
  }

  const keys = authActionKeys(actionType);
  
  let subject: string;
  let title: string;
  let body: string;
  
  if (input.channel === 'otp') {
    subject = authT(locale, 'auth.otp.subject');
    title = authT(locale, 'auth.otp.title');
    body = authT(locale, 'auth.otp.body');
  } else {
    subject = authT(locale, keys.subject);
    title = authT(locale, keys.title);
    body = authT(locale, keys.body);
  }

  const cta = authT(locale, keys.cta);
  const orEnterCode = authT(locale, 'auth.or_enter_code');
  const expires = authT(locale, 'auth.code_expires');
  const footer = authT(locale, 'auth.footer');

  const safeTitle = escapeHtml(title);
  const safeBody = escapeHtml(body);
  const safeCta = escapeHtml(cta);
  const safeOrCode = input.channel === 'otp' ? escapeHtml(authT(locale, 'auth.otp.code_label')) : escapeHtml(orEnterCode);
  const safeExpires = escapeHtml(expires);
  const safeFooter = escapeHtml(footer);
  const safeSite = siteName ? escapeHtml(siteName) : '';
  const safeToken = token ? escapeHtml(token) : '';
  const safeUrl = confirmUrl ? escapeAttr(confirmUrl) : '';

  const linkBlock = confirmUrl && input.channel === 'link'
    ? `
      ${emailCtaButton(safeUrl, safeCta)}
      <p style="color:${EMAIL_BRAND.muted};font-size:13px;word-break:break-all;text-align:center;">${safeFooter}<br/><a class="email-link" href="${safeUrl}" style="color:${EMAIL_BRAND.link};word-break:break-all;">${escapeHtml(confirmUrl)}</a></p>
    `
    : '';

  const codeBlock = token && input.channel === 'otp' ? emailCodeBlock(safeOrCode, safeToken) : '';

  const html = `
<!DOCTYPE html>
<html lang="${locale}">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
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
  siteUrl?: string;
}): string {
  let baseUrl = '';
  if (params.redirectTo) {
    try {
      baseUrl = new URL(params.redirectTo).origin;
    } catch {
      // ignore invalid URL
    }
  }
  if (!baseUrl && params.siteUrl) {
    baseUrl = params.siteUrl.replace(/\/$/, '');
  }
  if (!baseUrl) {
    baseUrl = params.supabaseUrl.replace(/\/$/, '');
  }

  const url = new URL(`${baseUrl}/auth/confirm`);
  url.searchParams.set('token_hash', params.tokenHash);
  url.searchParams.set('type', params.emailActionType);
  if (params.redirectTo) {
    url.searchParams.set('redirect_to', params.redirectTo);
  }
  return url.toString();
}
