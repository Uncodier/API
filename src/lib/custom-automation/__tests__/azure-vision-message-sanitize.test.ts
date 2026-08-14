import { normalizeOrDropAzureVisionImageUrl } from '../azure-vision-message-sanitize';

describe('normalizeOrDropAzureVisionImageUrl', () => {
  it('drops Twilio media URLs that Azure cannot authenticate', () => {
    const result = normalizeOrDropAzureVisionImageUrl(
      'https://api.twilio.com/2010-04-01/Accounts/ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/Messages/MM1/Media/ME1'
    );
    expect(result).toEqual({ ok: false, reason: 'auth_protected_twilio_media' });
  });

  it('keeps public HTTPS image URLs', () => {
    const url = 'https://cdn.example.com/photo.jpg';
    expect(normalizeOrDropAzureVisionImageUrl(url)).toEqual({ ok: true, url });
  });
});
