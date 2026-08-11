import { sendGridService } from './src/lib/services/sendgrid-service';
import { generateTeamInviteHtml, getTeamInviteSubject } from './src/lib/templates/team-invite-email';

async function sendTestEmail() {
  const locale = 'es';
  const email = 'sergio@uncodie.com';

  const subject = getTeamInviteSubject('Makinari Demo', locale);
  const html = generateTeamInviteHtml({
    memberName: 'Sergio',
    memberEmail: email,
    role: 'admin',
    position: 'Founder',
    siteName: 'Makinari Demo',
    signUpUrl: 'https://app.makinari.com/signup?invite=test',
    locale,
  });

  console.log(`Sending Team Invite test email to ${email}...`);
  console.log(`Subject: ${subject}`);

  try {
    const result = await sendGridService.sendEmail({
      to: email,
      subject,
      html,
      categories: ['team', 'invite', 'test'],
    });

    if (result.success) {
      console.log('✅ Email sent successfully!');
    } else {
      console.error('❌ Failed to send email:', result.error);
    }
  } catch (err) {
    console.error('💥 Exception sending email:', err);
  }
}

sendTestEmail().catch(console.error);
