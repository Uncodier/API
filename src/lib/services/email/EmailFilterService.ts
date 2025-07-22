/**
 * EmailFilterService - Servicio centralizado para filtrado de emails
 * Maneja la detección de delivery status, bounce emails, no-reply y otros tipos de emails automáticos
 */

export interface EmailFilterResult {
  isValid: boolean;
  reason?: string;
  category?: 'delivery_status' | 'bounce' | 'no_reply' | 'automated' | 'feedback_loop';
}

export class EmailFilterService {
  
  /**
   * Valida que un email no sea un delivery status notification (DSN) o bounce
   */
  static validateEmailNotDeliveryStatus(email: any): EmailFilterResult {
    const emailFrom = (email.from || '').toLowerCase();
    const emailSubject = (email.subject || '').toLowerCase();
    const emailContent = (email.body || email.text || '').toLowerCase();
    
    // Patrones comunes en el FROM de delivery status emails
    const deliveryStatusFromPatterns = [
      'mailer-daemon@',
      'mail-daemon@',
      'postmaster@',
      'mailerdaemon@',
      'mail-delivery-subsystem@',
      'delivery-status@',
      'bounce@',
      'bounces@',
      'return@',
      'returns@',
      'mail-delivery@',
      'maildelivery@'
    ];
    
    // Verificar patrones en FROM
    for (const pattern of deliveryStatusFromPatterns) {
      if (emailFrom.includes(pattern)) {
        return {
          isValid: false,
          reason: `Email de delivery status detectado por FROM: ${pattern}`,
          category: 'delivery_status'
        };
      }
    }
    
    // Patrones comunes en el SUBJECT de delivery status emails
    const deliveryStatusSubjectPatterns = [
      'delivery status notification',
      'delivery status',
      'mail delivery subsystem',
      'undelivered mail returned to sender',
      'undelivered',
      'delivery failure',
      'delivery report',
      'bounce',
      'returned mail',
      'mail system error',
      'permanent failure',
      'temporary failure',
      'delivery delayed',
      'mail delivery failed',
      'message delivery failed',
      'mail could not be delivered',
      'non-delivery notification',
      'auto-reply',
      'automatic reply',
      'out of office',
      'vacation reply'
    ];
    
    // Verificar patrones en SUBJECT
    for (const pattern of deliveryStatusSubjectPatterns) {
      if (emailSubject.includes(pattern)) {
        return {
          isValid: false,
          reason: `Email de delivery status detectado por SUBJECT: ${pattern}`,
          category: 'delivery_status'
        };
      }
    }
    
    // Verificar headers específicos de delivery status
    if (email.headers) {
      const headers = email.headers;
      
      // Auto-Submitted header
      if (headers['auto-submitted'] && 
          (headers['auto-submitted'].toLowerCase().includes('auto-replied') ||
           headers['auto-submitted'].toLowerCase().includes('auto-generated'))) {
        return {
          isValid: false,
          reason: 'Email de delivery status detectado por header Auto-Submitted',
          category: 'automated'
        };
      }
      
      // Content-Type multipart/report
      if (headers['content-type'] && 
          headers['content-type'].toLowerCase().includes('multipart/report')) {
        return {
          isValid: false,
          reason: 'Email de delivery status detectado por Content-Type multipart/report',
          category: 'delivery_status'
        };
      }
      
      // Precedence bulk
      if (headers['precedence'] && 
          headers['precedence'].toLowerCase() === 'bulk') {
        return {
          isValid: false,
          reason: 'Email de delivery status detectado por Precedence: bulk',
          category: 'automated'
        };
      }
      
      // X-Autoreply header
      if (headers['x-autoreply'] || headers['x-autorespond']) {
        return {
          isValid: false,
          reason: 'Email de delivery status detectado por header X-Autoreply',
          category: 'automated'
        };
      }
    }
    
    // Verificar patrones en el contenido que indican delivery status
    const deliveryStatusContentPatterns = [
      'this is an automatically generated delivery status notification',
      'your message could not be delivered',
      'delivery has failed',
      'message was not delivered',
      'mail delivery failed',
      'smtp error',
      'bounce message',
      'permanent failure',
      'temporary failure',
      'mailbox full',
      'user unknown',
      'host unknown',
      'delivery delayed'
    ];
    
    // Verificar patrones en CONTENT (solo si es corto para evitar falsos positivos)
    if (emailContent.length < 2000) { // Solo verificar en emails cortos
      for (const pattern of deliveryStatusContentPatterns) {
        if (emailContent.includes(pattern)) {
          return {
            isValid: false,
            reason: `Email de delivery status detectado por CONTENT: ${pattern}`,
            category: 'delivery_status'
          };
        }
      }
    }
    
    return { isValid: true };
  }

  /**
   * Identifica si un email es un bounce/delivery failure usando los mismos patrones 
   * que la ruta deliveryStatus existente para consistencia
   */
  static isBounceEmail(email: any): boolean {
    const from = (email.from || '').toLowerCase();
    const subject = (email.subject || '').toLowerCase();
    const body = (email.body || '').toLowerCase();

    // Verificar si viene de Mail Delivery Subsystem o similar
    const bounceFromPatterns = [
      'mail delivery subsystem',
      'postmaster',
      'mailer-daemon',
      'mail delivery system',
      'delivery status notification',
      'undelivered mail returned',
      'bounce',
      'delivery failure',
      'mail administrator'
    ];

    const fromMatches = bounceFromPatterns.some(pattern => from.includes(pattern));

    // Verificar patrones en el asunto
    const bounceSubjectPatterns = [
      'undelivered mail returned',
      'delivery status notification',
      'failure notice',
      'mail delivery failed',
      'returned mail',
      'delivery failure',
      'bounce',
      'undeliverable',
      'mail delivery subsystem',
      'permanent failure',
      'delivery report'
    ];

    const subjectMatches = bounceSubjectPatterns.some(pattern => subject.includes(pattern));

    // Verificar patrones en el cuerpo del mensaje
    const bounceBodyPatterns = [
      'permanent failure',
      'delivery failed',
      'user unknown',
      'mailbox not found',
      'recipient address rejected',
      'does not exist',
      'mailbox unavailable',
      'delivery to the following recipient failed',
      'the following addresses had permanent fatal errors',
      'host unknown'
    ];

    const bodyMatches = bounceBodyPatterns.some(pattern => body.includes(pattern));

    return fromMatches || subjectMatches || bodyMatches;
  }

  /**
   * Validación unificada que combina delivery status y bounce detection
   */
  static validateEmailNotDeliveryOrBounce(email: any): EmailFilterResult {
    // Primero verificar con la detección más granular
    const deliveryStatusResult = this.validateEmailNotDeliveryStatus(email);
    if (!deliveryStatusResult.isValid) {
      return deliveryStatusResult;
    }

    // Luego verificar con la detección de bounce compatible con deliveryStatus route
    const isBounce = this.isBounceEmail(email);
    if (isBounce) {
      return {
        isValid: false,
        reason: 'Email detectado como bounce por patrones de la ruta deliveryStatus',
        category: 'bounce'
      };
    }

    return { isValid: true };
  }

  /**
   * Validación de emails no-reply
   */
  static validateEmailNotFromNoReply(email: any, noReplyAddresses: string[]): EmailFilterResult {
    const emailFrom = (email.from || '').toLowerCase();
    
    // Verificar contra direcciones no-reply específicas
    for (const noReplyAddr of noReplyAddresses) {
      if (!noReplyAddr) continue;
      
      const normalizedAddr = noReplyAddr.toLowerCase();
      
      if (emailFrom.includes(normalizedAddr)) {
        return {
          isValid: false,
          reason: `Email viene de dirección no-reply configurada: ${normalizedAddr}`,
          category: 'no_reply'
        };
      }
      
      // Verificar dominio
      const noReplyDomain = this.extractDomainFromUrl(`mailto:${normalizedAddr}`);
      if (noReplyDomain && emailFrom.includes(noReplyDomain)) {
        return {
          isValid: false,
          reason: `Email viene de dominio no-reply configurado: ${noReplyDomain}`,
          category: 'no_reply'
        };
      }
    }
    
    // Verificar patrones comunes de no-reply
    const noReplyPatterns = [
      'noreply',
      'no-reply', 
      'donotreply',
      'do-not-reply',
      'automated',
      'system@',
      'daemon@',
      'postmaster@'
    ];
    
    for (const pattern of noReplyPatterns) {
      if (emailFrom.includes(pattern)) {
        return {
          isValid: false,
          reason: `Email contiene patrón no-reply: ${pattern}`,
          category: 'no_reply'
        };
      }
    }
    
    return { isValid: true };
  }

  /**
   * Validación completa que incluye todos los filtros
   */
  static validateEmail(email: any, noReplyAddresses: string[] = []): EmailFilterResult {
    // 1. Verificar delivery status/bounce
    const deliveryResult = this.validateEmailNotDeliveryOrBounce(email);
    if (!deliveryResult.isValid) {
      return deliveryResult;
    }

    // 2. Verificar no-reply
    const noReplyResult = this.validateEmailNotFromNoReply(email, noReplyAddresses);
    if (!noReplyResult.isValid) {
      return noReplyResult;
    }

    return { isValid: true };
  }

  /**
   * Filtra un array de emails aplicando todas las validaciones
   */
  static filterValidEmails(emails: any[], noReplyAddresses: string[] = []): {
    validEmails: any[];
    filteredEmails: Array<{ email: any; reason: string; category: string }>;
  } {
    const validEmails: any[] = [];
    const filteredEmails: Array<{ email: any; reason: string; category: string }> = [];

    for (const email of emails) {
      const validation = this.validateEmail(email, noReplyAddresses);
      
      if (validation.isValid) {
        validEmails.push(email);
      } else {
        filteredEmails.push({
          email,
          reason: validation.reason || 'Email filtrado',
          category: validation.category || 'unknown'
        });
      }
    }

    return { validEmails, filteredEmails };
  }

  /**
   * Utilidad para extraer dominio de URL
   */
  private static extractDomainFromUrl(url: string): string | null {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname.toLowerCase();
    } catch {
      return null;
    }
  }

  /**
   * Obtiene estadísticas de filtrado
   */
  static getFilteringStats(filteredEmails: Array<{ email: any; reason: string; category: string }>) {
    const stats = {
      total: filteredEmails.length,
      byCategory: {} as Record<string, number>
    };

    for (const filtered of filteredEmails) {
      const category = filtered.category || 'unknown';
      stats.byCategory[category] = (stats.byCategory[category] || 0) + 1;
    }

    return stats;
  }
} 