import {
  lastTenPhoneDigits,
  pickMatchingWhatsAppToken,
  storedWhatsAppIdentifierMatches,
  twilioWhatsAppFromCandidates,
  whatsappIdentifierSearchKeys,
} from '../whatsapp-number-match';

describe('whatsapp-number-match', () => {
  const twilioTo = '+5214611051101';
  const storedNumber = '+524611051101';

  it('treats Mexican WhatsApp +521 and stored +52 as the same number', () => {
    expect(storedWhatsAppIdentifierMatches(storedNumber, twilioTo)).toBe(true);
    expect(storedWhatsAppIdentifierMatches(twilioTo, storedNumber)).toBe(true);
    expect(lastTenPhoneDigits(twilioTo)).toBe('4611051101');
    expect(lastTenPhoneDigits(storedNumber)).toBe('4611051101');
  });

  it('includes the canonical +52 form in search keys for a +521 Twilio To', () => {
    const keys = whatsappIdentifierSearchKeys(twilioTo);
    expect(keys).toEqual(expect.arrayContaining([twilioTo, storedNumber, '4611051101']));
  });

  it('picks the Clemente token from a +521 inbound To', () => {
    const token = pickMatchingWhatsAppToken(
      [{ identifier: storedNumber, site_id: 'clemente' }],
      twilioTo
    );
    expect(token?.site_id).toBe('clemente');
  });

  it('does not match a different last-10 number', () => {
    expect(storedWhatsAppIdentifierMatches('+524611051101', '+5214611721870')).toBe(false);
  });

  it('builds Twilio From candidates with WhatsApp MX +521 first', () => {
    expect(twilioWhatsAppFromCandidates(storedNumber)).toEqual([twilioTo, storedNumber]);
    expect(twilioWhatsAppFromCandidates(twilioTo)).toEqual([twilioTo, storedNumber]);
    expect(twilioWhatsAppFromCandidates('+14155552671')).toEqual(['+14155552671']);
  });
});
