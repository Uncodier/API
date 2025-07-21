import { normalizePhoneForSearch, normalizePhoneForStorage, arePhoneNumbersEquivalent } from '@/lib/utils/phone-normalizer';

describe('Phone Number Normalizer', () => {
  describe('normalizePhoneForSearch', () => {
    it('should generate variants for Mexican phone numbers with country code and area code', () => {
      const variants = normalizePhoneForSearch('+52 (1) 5555551234');
      expect(variants).toContain('+5215555551234');
      expect(variants).toContain('5215555551234');
      expect(variants).toContain('15555551234');
      expect(variants).toContain('5555551234');
    });

    it('should generate variants for basic Mexican phone numbers', () => {
      const variants = normalizePhoneForSearch('5555551234');
      expect(variants).toContain('5555551234');
      expect(variants).toContain('+525555551234');
      expect(variants).toContain('525555551234');
      expect(variants).toContain('+5215555551234');
      expect(variants).toContain('5215555551234');
    });

    it('should handle phone numbers with formatting characters', () => {
      const variants = normalizePhoneForSearch('555-555-1234');
      expect(variants).toContain('5555551234');
    });

    it('should handle phone numbers with parentheses and spaces', () => {
      const variants = normalizePhoneForSearch('(555) 555-1234');
      expect(variants).toContain('5555551234');
    });

    it('should handle empty or invalid input', () => {
      expect(normalizePhoneForSearch('')).toEqual([]);
      expect(normalizePhoneForSearch(null as any)).toEqual([]);
      expect(normalizePhoneForSearch(undefined as any)).toEqual([]);
    });

    it('should handle 11-digit numbers with leading 1', () => {
      const variants = normalizePhoneForSearch('15555551234');
      expect(variants).toContain('15555551234');
      expect(variants).toContain('5555551234');
      expect(variants).toContain('+525555551234');
    });
  });

  describe('normalizePhoneForStorage', () => {
    it('should normalize a basic 10-digit Mexican number', () => {
      const result = normalizePhoneForStorage('5555551234');
      expect(result).toBe('+525555551234');
    });

    it('should preserve international format', () => {
      const result = normalizePhoneForStorage('+525555551234');
      expect(result).toBe('+525555551234');
    });

    it('should handle formatted numbers', () => {
      const result = normalizePhoneForStorage('(555) 555-1234');
      expect(result).toBe('+525555551234');
    });

    it('should handle 11-digit numbers with area code', () => {
      const result = normalizePhoneForStorage('15555551234');
      expect(result).toBe('+5215555551234');
    });

    it('should handle 12-digit numbers starting with 52', () => {
      const result = normalizePhoneForStorage('525555551234');
      expect(result).toBe('+525555551234');
    });

    it('should handle empty input', () => {
      expect(normalizePhoneForStorage('')).toBe('');
      expect(normalizePhoneForStorage(null as any)).toBe('');
      expect(normalizePhoneForStorage(undefined as any)).toBe('');
    });
  });

  describe('arePhoneNumbersEquivalent', () => {
    it('should recognize equivalent Mexican numbers in different formats', () => {
      expect(arePhoneNumbersEquivalent('+52 (1) 5555551234', '5555551234')).toBe(true);
      expect(arePhoneNumbersEquivalent('+525555551234', '5555551234')).toBe(true);
      expect(arePhoneNumbersEquivalent('(555) 555-1234', '5555551234')).toBe(true);
    });

    it('should recognize non-equivalent numbers', () => {
      expect(arePhoneNumbersEquivalent('5555551234', '5555551235')).toBe(false);
      expect(arePhoneNumbersEquivalent('5555551234', '6666661234')).toBe(false);
    });

    it('should handle edge cases', () => {
      expect(arePhoneNumbersEquivalent('', '5555551234')).toBe(false);
      expect(arePhoneNumbersEquivalent('5555551234', '')).toBe(false);
      expect(arePhoneNumbersEquivalent('', '')).toBe(false);
    });

    it('should recognize Twilio formatted numbers as equivalent to basic numbers', () => {
      // Este es el caso específico que mencionó el usuario
      expect(arePhoneNumbersEquivalent('+52 (1) 5555551234', '5555551234')).toBe(true);
      expect(arePhoneNumbersEquivalent('+52 1 5555551234', '5555551234')).toBe(true);
    });
  });
}); 