import { sendGridService } from './src/lib/services/sendgrid-service';
import { EMAIL_BRAND, emailBrandHeadTags, emailCtaButton } from './src/lib/emails/brand';
import { EmailSendService } from './src/lib/services/email/EmailSendService';

async function sendTestEmail() {
  const email = 'sergio@uncodie.com';
  const title = 'System notification QA';
  const message = 'Tu instancia terminó un paso y necesita revisión.\n\n- Sitio: Makinari Demo\n- Estado: listo para publicar';
  const instanceUrl = 'https://app.makinari.com';

  const html = `
      <!DOCTYPE html>
      <html lang="es">
      <head>
        <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        ${emailBrandHeadTags()}
      </head>
      <body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background-color:${EMAIL_BRAND.bodyBg};">
        <div class="email-card" style="max-width:600px;margin:40px auto;background-color:${EMAIL_BRAND.cardBg};border-radius:12px;overflow:hidden;">
          <div class="email-header" style="background:${EMAIL_BRAND.headerBg};padding:28px 32px;text-align:center;">
            <h1 class="email-header-title" style="margin:0;color:${EMAIL_BRAND.headerText};font-size:22px;font-weight:600;">${EmailSendService.escapeHtml(title)}</h1>
          </div>
          <div style="padding:32px;">
            <div class="email-text" style="font-size:16px;line-height:1.6;margin:0 0 8px;color:${EMAIL_BRAND.text};">
              ${EmailSendService.renderMessageWithLists(message)}
            </div>
            ${emailCtaButton(instanceUrl, 'Ver Instancia')}
          </div>
        </div>
      </body>
      </html>
    `;

  console.log(`Sending system_notification test to ${email}...`);
  const result = await sendGridService.sendEmail({
    to: email,
    subject: title,
    html,
    categories: ['qa', 'system-notification'],
  });

  if (result.success) console.log('✅ Email sent successfully!');
  else console.error('❌ Failed:', result.error);
}

sendTestEmail().catch(console.error);
