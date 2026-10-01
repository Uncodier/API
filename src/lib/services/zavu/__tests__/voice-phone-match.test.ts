import { matchesVoiceLeadPhone, normalizeVoiceIdentityPhone, voiceLeadPhoneSearchPattern } from '../voice-phone-match';

describe('Voice CRM phone matching', () => {
  it.each([
    '+525543640787', '+52 (55) 4364-0787', '525543640787', '52 55 4364 0787',
    '00525543640787', '+5215543640787', '+52 1 (55) 4364-0787', '5215543640787',
    '0052 1 (55) 4364-0787', '5543640787', '(55) 4364-0787', '55.4364.0787',
  ])('matches Mexican CRM format %s against either provider prefix', stored => {
    expect(matchesVoiceLeadPhone(stored, '+525543640787')).toBe(true);
    expect(matchesVoiceLeadPhone(stored, '+5215543640787')).toBe(true);
  });

  it.each([
    ['+13015550100', '1 (301) 555-0100'],
    ['+13015550100', '0013015550100'],
    ['+442079460958', '44 (20) 7946-0958'],
    ['+390612345678', '+39 06 1234 5678'],
    ['+4532345678', '+45 32 34 56 78'],
    ['+4532345678', '0045 32 34 56 78'],
  ])('matches full international phone %s stored as %s without dropping zeroes', (caller, stored) => {
    expect(matchesVoiceLeadPhone(stored, caller)).toBe(true);
  });

  it.each([
    null, undefined, 525543640787, '', '+15543640787', '15543640787', '+445543640787',
    '+5255436407879', '+5295543640787', '+525543640786', '+525543640787 ext 1',
    'tel:+525543640787', 'whatsapp:+525543640787', '++525543640787', '+5543640787',
    '005543640787', '+52%5543640787', '+52_5543640787', ' '.repeat(81) + '+525543640787',
  ])('rejects unrelated, malformed or ambiguous stored value %p', stored => {
    expect(matchesVoiceLeadPhone(stored, '+525543640787')).toBe(false);
  });

  it.each([
    ['+13015550100', '3015550100'], ['+13015550100', '+1315550100'],
    ['+442079460958', '02079460958'], ['+390612345678', '+39612345678'],
    ['+4532345678', '4532345678'], ['+4532345678', '(453) 234-5678'],
  ])('does not infer other countries or discard trunk digits for %s / %s', (caller, stored) => {
    expect(matchesVoiceLeadPhone(stored, caller)).toBe(false);
  });

  it('reserves an ambiguous bare ten-digit number for the CRM Mexican national format', () => {
    expect(matchesVoiceLeadPhone('(453) 234-5678', '+524532345678')).toBe(true);
    expect(matchesVoiceLeadPhone('(453) 234-5678', '+4532345678')).toBe(false);
  });

  it.each(['5543640787', '525543640787', '+525543640787x', '+00000000000', ''])('keeps provider identity validation strict for %s', caller => {
    expect(normalizeVoiceIdentityPhone(caller)).toBeUndefined();
    expect(matchesVoiceLeadPhone('+525543640787', caller)).toBe(false);
    expect(() => voiceLeadPhoneSearchPattern(caller)).toThrow('Invalid Voice caller phone');
  });

  it('keeps authoritative caller digits intact while narrowing candidates to explicit search aliases', () => {
    expect(normalizeVoiceIdentityPhone('0052 1 (55) 4364-0787')).toBe('+5215543640787');
    expect(voiceLeadPhoneSearchPattern('+525543640787')).toBe('%5%5%4%3%6%4%0%7%8%7%');
    expect(voiceLeadPhoneSearchPattern('+5215543640787')).toBe(voiceLeadPhoneSearchPattern('+525543640787'));
    expect(voiceLeadPhoneSearchPattern('+13015550100')).toBe('%1%3%0%1%5%5%5%0%1%0%0%');
  });
});