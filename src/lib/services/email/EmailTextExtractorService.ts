/**
 * EmailTextExtractorService
 * 
 * Servicio especializado para extraer únicamente el texto relevante de correos electrónicos,
 * optimizando para reducir tokens innecesarios al modelo de IA.
 */

import * as cheerio from 'cheerio';

export interface EmailTextContent {
  subject: string;
  from: string;
  to: string;
  plainText: string;
  extractedText: string; // Texto limpio optimizado para el modelo
  textLength: number;
  originalLength: number;
  compressionRatio: number;
}

export interface EmailTextExtractionOptions {
  maxTextLength?: number;
  removeSignatures?: boolean;
  removeQuotedText?: boolean;
  removeHeaders?: boolean;
  removeFooters?: boolean;
  preserveStructure?: boolean;
  removeLegalDisclaimer?: boolean;
}

export class EmailTextExtractorService {
  private static readonly DEFAULT_OPTIONS: EmailTextExtractionOptions = {
    maxTextLength: 2000,
    removeSignatures: true,
    removeQuotedText: true,
    removeHeaders: true,
    removeFooters: true,
    preserveStructure: false,
    removeLegalDisclaimer: true
  };

  /**
   * Extrae únicamente el texto relevante de un correo electrónico
   */
  static extractEmailText(
    email: any, 
    options: EmailTextExtractionOptions = {}
  ): EmailTextContent {
    const opts = { ...this.DEFAULT_OPTIONS, ...options };
    
    try {
      // Extraer campos básicos
      const subject = this.cleanSubject(email.subject || '');
      const from = this.extractEmailAddress(email.from || '');
      const to = this.extractEmailAddress(email.to || '');
      
      // Obtener el contenido del email
      let rawContent = '';
      if (email.html) {
        rawContent = this.extractTextFromHtml(email.html);
      } else if (email.text) {
        rawContent = email.text;
      } else if (email.body) {
        if (typeof email.body === 'string') {
          rawContent = email.body;
        } else if (email.body.html) {
          rawContent = this.extractTextFromHtml(email.body.html);
        } else if (email.body.text) {
          rawContent = email.body.text;
        }
      }

      const originalLength = rawContent.length;
      
      // Limpiar y optimizar el texto
      let cleanText = this.cleanEmailText(rawContent, opts);
      
      // Truncar si es necesario
      if (opts.maxTextLength && cleanText.length > opts.maxTextLength) {
        cleanText = cleanText.substring(0, opts.maxTextLength) + '...';
      }

      const compressionRatio = originalLength > 0 ? (cleanText.length / originalLength) : 0;

      return {
        subject,
        from,
        to,
        plainText: rawContent,
        extractedText: cleanText,
        textLength: cleanText.length,
        originalLength,
        compressionRatio
      };
    } catch (error) {
      console.error('[EmailTextExtractor] Error extracting email text:', error);
      return {
        subject: email.subject || '',
        from: email.from || '',
        to: email.to || '',
        plainText: '',
        extractedText: 'Error al extraer texto del email',
        textLength: 0,
        originalLength: 0,
        compressionRatio: 0
      };
    }
  }

  /**
   * Procesa múltiples emails y extrae solo el texto relevante
   */
  static extractMultipleEmailsText(
    emails: any[], 
    options: EmailTextExtractionOptions = {}
  ): EmailTextContent[] {
    return emails.map(email => this.extractEmailText(email, options));
  }

  /**
   * Extrae texto plano de contenido HTML
   */
  private static extractTextFromHtml(html: string): string {
    try {
      const $ = cheerio.load(html);
      
      // Eliminar elementos que generalmente no contienen contenido útil
      $('script, style, meta, link, head, noscript').remove();
      
      // Eliminar comentarios HTML
      $('*').contents().each(function() {
        if (this.type === 'comment') {
          $(this).remove();
        }
      });

      // Obtener texto plano
      const text = $('body').length ? $('body').text() : $.text();
      
      return text.replace(/\s+/g, ' ').trim();
    } catch (error) {
      console.error('[EmailTextExtractor] Error extracting text from HTML:', error);
      return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    }
  }

  /**
   * Limpia el asunto del email
   */
  private static cleanSubject(subject: string): string {
    return subject
      .replace(/^(Re:|RE:|Fwd:|FWD:|Fw:)\s*/gi, '') // Eliminar prefijos de respuesta/reenvío
      .replace(/\[.*?\]/g, '') // Eliminar contenido entre corchetes
      .trim();
  }

  /**
   * Extrae dirección de email limpia
   */
  private static extractEmailAddress(emailField: string): string {
    const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/;
    const match = emailField.match(emailRegex);
    return match ? match[1] : emailField.trim();
  }

  /**
   * Limpia el texto del email eliminando contenido innecesario
   */
  private static cleanEmailText(text: string, options: EmailTextExtractionOptions): string {
    let cleanText = text;

    // Normalizar espacios en blanco
    cleanText = cleanText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    
    // Eliminar firmas si está habilitado
    if (options.removeSignatures) {
      cleanText = this.removeEmailSignatures(cleanText);
    }
    
    // Eliminar texto citado/quoted si está habilitado
    if (options.removeQuotedText) {
      cleanText = this.removeQuotedText(cleanText);
    }
    
    // Eliminar headers de email si está habilitado
    if (options.removeHeaders) {
      cleanText = this.removeEmailHeaders(cleanText);
    }
    
    // Eliminar footers/disclaimers legales si está habilitado
    if (options.removeLegalDisclaimer) {
      cleanText = this.removeLegalDisclaimer(cleanText);
    }

    // Limpiar múltiples saltos de línea
    cleanText = cleanText.replace(/\n{3,}/g, '\n\n');
    
    // Limpiar espacios múltiples
    cleanText = cleanText.replace(/[ \t]+/g, ' ');
    
    // Eliminar líneas que solo contienen espacios
    cleanText = cleanText.replace(/^\s*$/gm, '');
    
    return cleanText.trim();
  }

  /**
   * Elimina firmas de email comunes
   */
  private static removeEmailSignatures(text: string): string {
    // Patrones comunes de firmas
    const signaturePatterns = [
      /^\s*--\s*$/m, // Línea de separación estándar de firma
      /^[-_=]{2,}$/m, // Líneas de separación hechas con guiones o guiones bajos
      /^\s*Saludos,?\s*$/m,
      /^\s*Best regards,?\s*$/m,
      /^\s*Atentamente,?\s*$/m,
      /^\s*Cordialmente,?\s*$/m,
      /^\s*Sent from my .+$/m, // "Sent from my iPhone" etc.
      /^\s*Enviado desde .+$/m,
    ];

    // Encontrar el primer patrón de firma y cortar ahí
    for (const pattern of signaturePatterns) {
      const match = text.match(pattern);
      if (match && match.index !== undefined) {
        text = text.substring(0, match.index).trim();
        break;
      }
    }

    return text;
  }

  /**
   * Elimina texto citado/quoted (respuestas anteriores)
   */
  private static removeQuotedText(text: string): string {
    const lines = text.split('\n');
    const filteredLines: string[] = [];
    let inQuotedSection = false;

    for (const line of lines) {
      // Detectar inicio de texto citado
      if (line.match(/^>\s*/) || // Líneas que empiezan con >
          line.match(/^On .+ wrote:$/i) || // "On [date] [person] wrote:"
          line.match(/^El .+ escribió:$/i) || // "El [fecha] [persona] escribió:"
          line.match(/^From:\s*.+$/i) || // Headers de email quoted
          line.match(/^De:\s*.+$/i)) {
        inQuotedSection = true;
        continue;
      }

      // Si no estamos en sección citada, mantener la línea
      if (!inQuotedSection) {
        filteredLines.push(line);
      }
    }

    return filteredLines.join('\n');
  }

  /**
   * Elimina headers de email
   */
  private static removeEmailHeaders(text: string): string {
    const headerPatterns = [
      /^From:\s*.+$/im,
      /^To:\s*.+$/im,
      /^Subject:\s*.+$/im,
      /^Date:\s*.+$/im,
      /^Sent:\s*.+$/im,
      /^De:\s*.+$/im,
      /^Para:\s*.+$/im,
      /^Asunto:\s*.+$/im,
      /^Fecha:\s*.+$/im,
      /^Enviado:\s*.+$/im,
    ];

    let cleanText = text;
    headerPatterns.forEach(pattern => {
      cleanText = cleanText.replace(pattern, '');
    });

    return cleanText;
  }

  /**
   * Elimina disclaimers legales y footers corporativos
   */
  private static removeLegalDisclaimer(text: string): string {
    const disclaimerPatterns = [
      /\*{3,}[\s\S]*?\*{3,}/g, // Texto entre asteriscos múltiples
      /={3,}[\s\S]*?={3,}/g, // Texto entre signos igual múltiples
      /^DISCLAIMER:.*$/gmi,
      /^CONFIDENTIAL.*$/gmi,
      /^This email is confidential.*$/gmi,
      /^Este correo es confidencial.*$/gmi,
      /^AVISO LEGAL.*$/gmi,
      /^LEGAL NOTICE.*$/gmi,
      /^Please consider the environment.*$/gmi,
      /^Por favor considera el medio ambiente.*$/gmi,
    ];

    let cleanText = text;
    disclaimerPatterns.forEach(pattern => {
      cleanText = cleanText.replace(pattern, '');
    });

    return cleanText;
  }
} 