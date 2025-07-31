/**
 * ValidationService - Servicio para validaciones comunes
 * Maneja validaciones de UUIDs, emails y otras utilidades
 */

export class ValidationService {
  
  /**
   * Valida si una cadena es un UUID válido
   */
  static isValidUUID(uuid: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
  }

  /**
   * Valida si una cadena es un email válido
   */
  static isValidEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  /**
   * Valida parámetros requeridos en un objeto
   */
  static validateRequiredFields(data: any, requiredFields: string[]): { isValid: boolean; missingFields: string[] } {
    const missingFields = requiredFields.filter(field => !data[field]);
    return {
      isValid: missingFields.length === 0,
      missingFields
    };
  }

  /**
   * Sanitiza una cadena removiendo caracteres especiales
   */
  static sanitizeString(str: string): string {
    return str.replace(/[<>'"&]/g, '').trim();
  }

  /**
   * Valida y normaliza un email
   */
  static normalizeEmail(email: string): string | null {
    if (!email || typeof email !== 'string') return null;
    
    const normalized = email.toLowerCase().trim();
    return this.isValidEmail(normalized) ? normalized : null;
  }

  /**
   * Extrae el email de una cadena que puede contener formato "Name <email@domain.com>"
   */
  static extractEmailFromString(emailString: string): string | null {
    if (!emailString) return null;
    
    const emailMatch = emailString.match(/<([^>]+)>/);
    const extractedEmail = emailMatch ? emailMatch[1] : emailString;
    
    return this.normalizeEmail(extractedEmail);
  }

  /**
   * Valida si un string contiene solo números
   */
  static isNumericString(str: string): boolean {
    return /^\d+$/.test(str);
  }

  /**
   * Valida límites de paginación
   */
  static validatePaginationLimits(limit: number, maxLimit: number = 100): number {
    if (limit <= 0) return 1;
    if (limit > maxLimit) return maxLimit;
    return limit;
  }

  /**
   * Valida formato de fecha ISO
   */
  static isValidISODate(dateString: string): boolean {
    if (!dateString) return false;
    const date = new Date(dateString);
    return date instanceof Date && !isNaN(date.getTime()) && dateString.includes('T');
  }
}