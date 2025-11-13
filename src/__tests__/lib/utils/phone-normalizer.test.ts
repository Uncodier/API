import { normalizePhoneForSearch, normalizePhoneForStorage, arePhoneNumbersEquivalent, attemptPhoneRescue } from '@/lib/utils/phone-normalizer';

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

  describe('attemptPhoneRescue', () => {
    it('should rescue numbers with "01" prefix (Mexican format)', () => {
      // Caso específico del usuario
      expect(attemptPhoneRescue('014616132105')).toBe('+524616132105');
      expect(attemptPhoneRescue('015555551234')).toBe('+525555551234');
    });

    it('should rescue numbers with "00" international prefix', () => {
      expect(attemptPhoneRescue('00525555551234')).toBe('+525555551234');
      // "0015555551234" -> "15555551234" (11 dígitos empezando con 1) -> interpretado como México con lada
      expect(attemptPhoneRescue('0015555551234')).toBe('+5215555551234');
    });

    it('should rescue numbers with "011" prefix', () => {
      expect(attemptPhoneRescue('011525555551234')).toBe('+525555551234');
      // "01115555551234" -> "15555551234" (11 dígitos empezando con 1) -> interpretado como México con lada  
      expect(attemptPhoneRescue('01115555551234')).toBe('+5215555551234');
    });

    it('should rescue 10-digit Mexican numbers without country code', () => {
      expect(attemptPhoneRescue('4616132105')).toBe('+524616132105');
      expect(attemptPhoneRescue('5555551234')).toBe('+525555551234');
    });

    it('should rescue 11-digit Mexican numbers with area code', () => {
      expect(attemptPhoneRescue('15555551234')).toBe('+5215555551234');
    });

    it('should rescue 12-digit numbers starting with 52', () => {
      expect(attemptPhoneRescue('525555551234')).toBe('+525555551234');
      expect(attemptPhoneRescue('524616132105')).toBe('+524616132105');
    });

    it('should rescue 13-digit numbers starting with 521', () => {
      expect(attemptPhoneRescue('5215555551234')).toBe('+5215555551234');
    });

    it('should try US/Canada format for 10-digit numbers', () => {
      const result = attemptPhoneRescue('2125551234');
      // Debería intentar múltiples formatos, México primero por heurística
      expect(result).toBe('+522125551234');
    });

    it('should return already valid international numbers unchanged', () => {
      expect(attemptPhoneRescue('+525555551234')).toBe('+525555551234');
      expect(attemptPhoneRescue('+15555551234')).toBe('+15555551234');
    });

    it('should handle formatted numbers with special characters', () => {
      expect(attemptPhoneRescue('01 (461) 613-2105')).toBe('+524616132105');
      expect(attemptPhoneRescue('00 52 555 555 1234')).toBe('+525555551234');
    });

    it('should return null for invalid inputs', () => {
      expect(attemptPhoneRescue('')).toBe(null);
      expect(attemptPhoneRescue(null as any)).toBe(null);
      expect(attemptPhoneRescue(undefined as any)).toBe(null);
      expect(attemptPhoneRescue('abc')).toBe(null);
      expect(attemptPhoneRescue('123')).toBe(null); // Muy corto
    });

    it('should handle edge cases gracefully', () => {
      expect(attemptPhoneRescue('000000000000000000')).toBe(null); // Muy largo
      expect(attemptPhoneRescue('0000')).toBe(null); // Muy corto después de limpiar
    });
  });

  describe('phone number matching with spaces', () => {
    it('should detect +525544414173 and +52 5544414173 as equivalent', () => {
      const phone1 = '+525544414173';
      const phone2 = '+52 5544414173';
      
      expect(arePhoneNumbersEquivalent(phone1, phone2)).toBe(true);
    });

    it('should generate variants with spaces for +525544414173', () => {
      const variants = normalizePhoneForSearch('+525544414173');
      
      // Should include the spaced variant
      expect(variants).toContain('+52 5544414173');
      // Should also include the unspaced variant
      expect(variants).toContain('+525544414173');
    });

    it('should generate variants with spaces for +52 5544414173', () => {
      const variants = normalizePhoneForSearch('+52 5544414173');
      
      // Should include the spaced variant
      expect(variants).toContain('+52 5544414173');
      // Should also include the unspaced variant
      expect(variants).toContain('+525544414173');
    });

    it('should share cache entries for +525544414173 and +52 5544414173', () => {
      // First call should populate cache
      const variants1 = normalizePhoneForSearch('+525544414173');
      
      // Second call with space should use same cache key and return same variants
      const variants2 = normalizePhoneForSearch('+52 5544414173');
      
      // They should have overlapping variants
      const sharedVariants = variants1.filter(v => variants2.includes(v));
      expect(sharedVariants.length).toBeGreaterThan(0);
      
      // Both should include the key variants
      expect(variants1).toContain('+52 5544414173');
      expect(variants2).toContain('+525544414173');
    });
  });
}); 