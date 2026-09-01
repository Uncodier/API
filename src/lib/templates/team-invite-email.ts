import { EmailSendService } from '../services/email/EmailSendService';
import type { EmailLocale } from '@/lib/i18n/email-locale';
import { DEFAULT_EMAIL_LOCALE } from '@/lib/i18n/email-locale';
import { platformT } from '@/lib/i18n/email-messages/platform';
import { EMAIL_BRAND, emailBadge, emailBrandHeadTags } from '@/lib/emails/brand';

export interface TeamInviteEmailData {
  memberName: string;
  memberEmail: string;
  role: string;
  position: string;
  siteName: string;
  signUpUrl?: string;
  locale?: EmailLocale;
}

function getBrandingText(): string {
  return process.env.UNCODIE_BRANDING_TEXT || 'Makinari, your AI Sales Team';
}

function getSignUpUrl(override?: string): string {
  if (override) return override;
  return process.env.NEXT_PUBLIC_APP_URL
    ? `${process.env.NEXT_PUBLIC_APP_URL}/signup`
    : 'https://app.makinari.com/signup';
}

export function getCompanyName(): string {
  return process.env.UNCODIE_COMPANY_NAME || 'Makinari';
}

function getCompanyTagline(): string {
  return process.env.UNCODIE_COMPANY_TAGLINE || 'AI-powered team collaboration';
}

export function getTeamInviteSubject(siteName: string, locale: EmailLocale = DEFAULT_EMAIL_LOCALE): string {
  return platformT(locale, 'invite.subject', { siteName });
}

export function generateTeamInviteHtml(data: TeamInviteEmailData): string {
  const locale = data.locale || DEFAULT_EMAIL_LOCALE;
  const roleKey = `invite.role.${data.role}`;
  const roleLabelRaw = platformT(locale, roleKey);
  const finalRoleLabel = roleLabelRaw === roleKey ? data.role : roleLabelRaw;

  const escapedSiteName = EmailSendService.escapeHtml(data.siteName);
  const escapedMemberEmail = EmailSendService.escapeHtml(data.memberEmail);
  const escapedPosition = EmailSendService.escapeHtml(data.position);
  const escapedCompanyName = EmailSendService.escapeHtml(getCompanyName());
  const escapedBrandingText = EmailSendService.escapeHtml(getBrandingText());
  const escapedCompanyTagline = EmailSendService.escapeHtml(getCompanyTagline());
  const escapedRoleLabel = EmailSendService.escapeHtml(finalRoleLabel);
  const title = EmailSendService.escapeHtml(platformT(locale, 'invite.title'));
  const body = EmailSendService.escapeHtml(
    platformT(locale, 'invite.body', {
      siteName: data.siteName,
      role: finalRoleLabel,
      position: data.position,
    })
  );
  const cta = EmailSendService.escapeHtml(platformT(locale, 'invite.cta'));
  const hello = EmailSendService.escapeHtml(
    platformT(locale, 'common.hello', { name: data.memberName })
  );
  const signUpUrl = EmailSendService.escapeAttr(getSignUpUrl(data.signUpUrl));

  return `
    <!DOCTYPE html>
    <html lang="${locale}">
    <head>
      <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${title} - ${escapedSiteName}</title>
      ${emailBrandHeadTags()}
    </head>
    <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: ${EMAIL_BRAND.bodyBg}; line-height: 1.6;">
      <div class="email-card" style="max-width: 600px; margin: 40px auto; background-color: ${EMAIL_BRAND.cardBg}; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(30, 30, 45, 0.1); overflow: hidden;">
        <div class="email-header" style="background: ${EMAIL_BRAND.headerBg}; padding: 32px 40px; text-align: center;">
          <h1 class="email-header-title" style="margin: 0; color: ${EMAIL_BRAND.headerText}; font-size: 24px; font-weight: 600;">${title}</h1>
          <p class="email-header-sub" style="margin: 8px 0 0; color: ${EMAIL_BRAND.headerMuted}; font-size: 16px;">${escapedSiteName} · ${escapedCompanyName}</p>
        </div>
        <div style="padding: 40px;">
          <div style="margin-bottom: 32px; text-align: center;">
            <h2 class="email-heading" style="margin: 0 0 16px; font-size: 20px; color: ${EMAIL_BRAND.surfaceText}; font-weight: 600;">${hello}</h2>
            <p class="email-text" style="margin: 0; font-size: 16px; color: ${EMAIL_BRAND.text}; line-height: 1.7;">${body}</p>
          </div>
          <div style="margin-bottom: 24px; text-align: center;">
            ${emailBadge(escapedRoleLabel)}
          </div>
          <div style="margin-bottom: 32px;">
            <div class="email-panel" style="background-color: ${EMAIL_BRAND.panelBg}; padding: 24px; border-radius: 8px; border: 1px solid ${EMAIL_BRAND.panelBorder};">
              <div class="email-text" style="margin-bottom: 12px;"><strong>${escapedSiteName}</strong></div>
              <div class="email-text" style="margin-bottom: 12px; color: ${EMAIL_BRAND.surfaceText}; -webkit-text-fill-color: ${EMAIL_BRAND.surfaceText};">${escapedPosition}</div>
              <div><a class="email-link" href="mailto:${escapedMemberEmail}" style="color: ${EMAIL_BRAND.link}; text-decoration: none;">${escapedMemberEmail}</a></div>
            </div>
          </div>
          <div style="text-align: center; margin: 40px 0 32px;">
            <a href="${signUpUrl}"
               class="email-cta" style="display: inline-block; padding: 16px 32px; background-color: ${EMAIL_BRAND.black}; background-image: linear-gradient(${EMAIL_BRAND.black}, ${EMAIL_BRAND.black}); box-shadow: inset 0 0 0 999px ${EMAIL_BRAND.black}; color: ${EMAIL_BRAND.white}; border: 0; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">
              <span class="email-cta-label" style="color: ${EMAIL_BRAND.white};">${cta}</span>
            </a>
          </div>
          <div style="text-align: center; padding-top: 24px; border-top: 1px solid ${EMAIL_BRAND.surfaceBorder};">
            <p class="email-muted" style="margin: 0; color: ${EMAIL_BRAND.muted}; font-size: 12px;">
              ${EmailSendService.escapeHtml(platformT(locale, 'common.support'))}
            </p>
          </div>
        </div>
      </div>
      <div style="text-align: center; margin: 20px 0 40px;">
        <p class="email-subtle" style="margin: 0; color: ${EMAIL_BRAND.subtle}; font-size: 12px;">
          ${escapedBrandingText} · ${escapedCompanyTagline}
        </p>
      </div>
    </body>
    </html>
  `;
}
