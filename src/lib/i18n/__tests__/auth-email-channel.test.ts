import { resolveAuthEmailChannel } from '@/lib/i18n/auth-email-channel';

describe('resolveAuthEmailChannel', () => {
  it('treats shop checkout as OTP when redirect_to has auth_channel=otp', () => {
    expect(
      resolveAuthEmailChannel({
        email_action_type: 'magiclink',
        redirect_to: 'https://makinari.com/auth/confirm?auth_channel=otp&returnTo=%2Fshop%2Fhabi',
      })
    ).toBe('otp');
  });

  it('treats app confirm magiclink without the query as link', () => {
    expect(
      resolveAuthEmailChannel({
        email_action_type: 'magiclink',
        redirect_to: 'https://app.makinari.com/auth/confirm?returnTo=%2Fdashboard',
      })
    ).toBe('link');
  });

  it('treats recovery as link', () => {
    expect(
      resolveAuthEmailChannel({
        email_action_type: 'recovery',
        redirect_to: 'https://app.makinari.com/auth/confirm',
      })
    ).toBe('link');
  });

  it('treats reauthentication as OTP', () => {
    expect(resolveAuthEmailChannel({ email_action_type: 'reauthentication' })).toBe('otp');
  });

  it('treats magiclink with only the Site URL as OTP (GoTrue dropped shop redirect)', () => {
    expect(
      resolveAuthEmailChannel({
        email_action_type: 'magiclink',
        redirect_to: 'https://app.makinari.com',
      })
    ).toBe('otp');
    expect(
      resolveAuthEmailChannel({
        email_action_type: 'magiclink',
        redirect_to: 'https://app.makinari.com/',
      })
    ).toBe('otp');
  });

  it('falls back to OTP when redirect_to is a shop path', () => {
    expect(
      resolveAuthEmailChannel({
        email_action_type: 'magiclink',
        redirect_to: 'https://makinari.com/shop/habi',
      })
    ).toBe('otp');
  });
});
