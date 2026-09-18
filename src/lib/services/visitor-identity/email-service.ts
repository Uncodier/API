import { generateAuthEmailContent } from '@/lib/i18n/auth-email-template';
import { resolveEmailLocale } from '@/lib/i18n/email-locale';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { sendGridService } from '@/lib/services/sendgrid-service';
import { VisitorIdentityError } from './contracts';

export class VisitorIdentityEmailService {
  async sendCode(params: {
    siteId: string;
    leadId: string;
    email: string;
    code: string;
  }): Promise<void> {
    const [{ data: site }, locale] = await Promise.all([
      supabaseAdmin.from('sites').select('name').eq('id', params.siteId).maybeSingle(),
      resolveEmailLocale({ siteId: params.siteId, leadId: params.leadId })
    ]);

    const siteName = site?.name || 'Makinari';
    const content = generateAuthEmailContent({
      locale,
      actionType: 'reauthentication',
      channel: 'otp',
      token: params.code,
      siteName,
      userEmail: params.email
    });

    const result = await sendGridService.sendEmail({
      to: params.email,
      subject: `Your verification code for ${siteName}`,
      html: content.html,
      text: content.text,
      categories: ['visitor-identity-verification']
    });
    if (!result.success) {
      throw new VisitorIdentityError(
        'email_delivery_failed',
        'Unable to send the verification email',
        502
      );
    }
  }
}

export const visitorIdentityEmailService = new VisitorIdentityEmailService();
