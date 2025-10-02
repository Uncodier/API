/**
 * EmailTextExtractorService
 * 
 * Servicio especializado para extraer únicamente el texto relevante de correos electrónicos,
 * optimizando para reducir tokens innecesarios al modelo de IA.
 */

import * as cheerio from 'cheerio';
import { cleanHtmlBasic } from '@/lib/utils/html-content-cleaner';

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
      // PRIORITY: Prefer text over HTML when both are available (text is cleaner and shorter for AI)
      let rawContent = '';
      if (email.text) {
        rawContent = email.text;
      } else if (email.body) {
        if (typeof email.body === 'string') {
          rawContent = email.body;
        } else if (email.body.text) {
          rawContent = email.body.text;
        } else if (email.body.html) {
          rawContent = this.extractTextFromHtml(email.body.html);
        }
      } else if (email.html) {
        rawContent = this.extractTextFromHtml(email.html);
      }

      const originalLength = rawContent.length;
      
      // Limpiar y optimizar el texto
      let cleanText = this.cleanEmailText(rawContent, opts);
      
      // Aplicar corrección de codificación de caracteres al final
      cleanText = this.fixTextEncoding(cleanText);
      
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
      return cleanHtmlBasic(html);
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

    // Primero, remover estructuras MIME y multipart (debe ser antes de todo)
    cleanText = this.removeMimeStructures(cleanText);

    // Normalizar espacios en blanco
    cleanText = cleanText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    
    // Eliminar headers de email si está habilitado (mejorado para incluir MIME headers)
    if (options.removeHeaders) {
      cleanText = this.removeEmailHeaders(cleanText);
    }
    
    // Eliminar firmas si está habilitado
    if (options.removeSignatures) {
      cleanText = this.removeEmailSignatures(cleanText);
    }
    
    // Eliminar texto citado/quoted si está habilitado
    if (options.removeQuotedText) {
      cleanText = this.removeQuotedText(cleanText);
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
   * Remueve estructuras MIME multipart y boundaries
   */
  private static removeMimeStructures(text: string): string {
    let cleanText = text;

    // 🎯 MEJORADO: Remover boundaries MIME más específicos
    // Boundaries con formato específico como el ejemplo
    cleanText = cleanText.replace(/^----[a-zA-Z0-9_]+.*$/gm, '');
    cleanText = cleanText.replace(/^--[a-zA-Z0-9_]{20,}.*$/gm, '');
    
    // Remover headers Content-Type multiline con charset y encoding
    cleanText = cleanText.replace(/^Content-Type:\s*.*charset=.*$/gmi, '');
    cleanText = cleanText.replace(/^Content-Type:\s*.*encoding=.*$/gmi, '');
    cleanText = cleanText.replace(/^Content-Type:\s*.*method=.*$/gmi, '');
    cleanText = cleanText.replace(/^Content-Type:\s*.*$/gmi, '');
    cleanText = cleanText.replace(/^Content-Transfer-Encoding:\s*.*$/gmi, '');
    cleanText = cleanText.replace(/^Content-Disposition:\s*.*$/gmi, '');
    cleanText = cleanText.replace(/^Content-Description:\s*.*$/gmi, '');
    
    // Remover líneas con charset y boundary definitions
    cleanText = cleanText.replace(/^.*charset=.*$/gmi, '');
    cleanText = cleanText.replace(/^.*boundary=.*$/gmi, '');
    cleanText = cleanText.replace(/^.*method=.*$/gmi, '');
    
    // Remover headers MIME técnicos adicionales
    cleanText = cleanText.replace(/^MIME-Version:\s*.*$/gmi, '');
    cleanText = cleanText.replace(/^X-.*?:\s*.*$/gmi, ''); // Headers X- personalizados
    
    // 🎯 NUEVO: Remover contenido Base64 de calendarios y archivos
    cleanText = cleanText.replace(/^[A-Za-z0-9+/]{50,}={0,2}$/gm, ''); // Líneas largas de Base64
    
    // Remover líneas que solo contienen = (quoted-printable artifacts)
    cleanText = cleanText.replace(/^=+$/gm, '');
    
    // Remover secuencias de quoted-printable problemáticas
    cleanText = cleanText.replace(/=\s*$/gm, ''); // Líneas que terminan con =
    cleanText = cleanText.replace(/=\n/g, ''); // Saltos de línea codificados
    
    // 🎯 NUEVO: Remover líneas vacías múltiples que quedan después de limpiar
    cleanText = cleanText.replace(/\n{3,}/g, '\n\n');
    
    return cleanText;
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
          line.match(/^De:\s*.+$/i) ||
          line.match(/^Original Thread:/i)) { // "Original Thread:" markers
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
   * Elimina headers de email (mejorado para incluir MIME headers)
   */
  private static removeEmailHeaders(text: string): string {
    const headerPatterns = [
      // Headers básicos de email
      /^From:\s*.+$/gmi,
      /^To:\s*.+$/gmi,
      /^Subject:\s*.+$/gmi,
      /^Date:\s*.+$/gmi,
      /^Sent:\s*.+$/gmi,
      /^De:\s*.+$/gmi,
      /^Para:\s*.+$/gmi,
      /^Asunto:\s*.+$/gmi,
      /^Fecha:\s*.+$/gmi,
      /^Enviado:\s*.+$/gmi,
      
      // Headers MIME y técnicos
      /^Content-Type:\s*.+$/gmi,
      /^Content-Transfer-Encoding:\s*.+$/gmi,
      /^Content-Disposition:\s*.+$/gmi,
      /^Content-Description:\s*.+$/gmi,
      /^Content-ID:\s*.+$/gmi,
      /^MIME-Version:\s*.+$/gmi,
      
      // Headers adicionales comunes
      /^Message-ID:\s*.+$/gmi,
      /^In-Reply-To:\s*.+$/gmi,
      /^References:\s*.+$/gmi,
      /^Return-Path:\s*.+$/gmi,
      /^Received:\s*.+$/gmi,
      /^Reply-To:\s*.+$/gmi,
      /^Cc:\s*.+$/gmi,
      /^Bcc:\s*.+$/gmi,
      /^Priority:\s*.+$/gmi,
      /^Importance:\s*.+$/gmi,
      /^X-.*?:\s*.+$/gmi, // Todos los headers X- personalizados
      
      // Headers de email clients específicos
      /^Delivered-To:\s*.+$/gmi,
      /^Authentication-Results:\s*.+$/gmi,
      /^ARC-.*?:\s*.+$/gmi,
      /^DKIM-.*?:\s*.+$/gmi,
      /^SPF-.*?:\s*.+$/gmi,
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
      /^If you don't want to hear from me again.*$/gmi, // Unsubscribe messages
      /^Si no quieres recibir más.*$/gmi,
    ];

    let cleanText = text;
    disclaimerPatterns.forEach(pattern => {
      cleanText = cleanText.replace(pattern, '');
    });

    return cleanText;
  }

  /**
   * Corrige problemas de codificación de caracteres en texto
   */
  private static fixTextEncoding(text: string): string {
    if (!text || typeof text !== 'string') {
      return text;
    }
    
    try {
      let fixedText = text;
      
                           // Aplicar correcciones usando replace directo para evitar problemas de encoding
       fixedText = fixedText
         // Correcciones más comunes de UTF-8 mal interpretado como ISO-8859-1
         .replace(/Ã¡/g, 'á').replace(/Ã©/g, 'é').replace(/Ã­/g, 'í').replace(/Ã³/g, 'ó').replace(/Ãº/g, 'ú')
         .replace(/Ã /g, 'à').replace(/Ã¨/g, 'è').replace(/Ã¬/g, 'ì').replace(/Ã²/g, 'ò').replace(/Ã¹/g, 'ù')
         .replace(/Ã¢/g, 'â').replace(/Ãª/g, 'ê').replace(/Ã®/g, 'î').replace(/Ã´/g, 'ô').replace(/Ã»/g, 'û')
         .replace(/Ã£/g, 'ã').replace(/Ã±/g, 'ñ').replace(/Ã§/g, 'ç')
         // Mayúsculas
         .replace(/Ã€/g, 'À').replace(/Ã‰/g, 'É').replace(/Ã"/g, 'Ó').replace(/Ã‡/g, 'Ç')
         .replace(/Ã‚/g, 'Â').replace(/ÃŠ/g, 'Ê').replace(/ÃŽ/g, 'Î').replace(/Ã„/g, 'Ä').replace(/Ã‹/g, 'Ë')
         .replace(/Ã–/g, 'Ö').replace(/Ãœ/g, 'Ü')
         // Espacios problemáticos
         .replace(/Â /g, ' ').replace(/Â/g, '')
         // Símbolos comunes problemáticos
         .replace(/Â°/g, '°').replace(/Â£/g, '£').replace(/Â©/g, '©').replace(/Â®/g, '®')
         
         // Correcciones adicionales con regex para patrones
         // Secuencias de A seguidas de caracteres especiales (patrón común UTF-8 mal interpretado)
         .replace(/Ã([¡-ÿ])/g, (match, p1) => {
           const charCode = p1.charCodeAt(0);
           return String.fromCharCode(192 + charCode - 161);
         })
         
         // Limpiar espacios múltiples que puedan quedar después de las correcciones
         .replace(/\s+/g, ' ')
         
         // Remover caracteres de control problemáticos
         .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

      // Intentar decodificar HTML entities si están presentes
      const htmlEntities: { [key: string]: string } = {
        '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
        '&aacute;': 'á', '&eacute;': 'é', '&iacute;': 'í', '&oacute;': 'ó', '&uacute;': 'ú',
        '&agrave;': 'à', '&egrave;': 'è', '&igrave;': 'ì', '&ograve;': 'ò', '&ugrave;': 'ù',
        '&acirc;': 'â', '&ecirc;': 'ê', '&icirc;': 'î', '&ocirc;': 'ô', '&ucirc;': 'û',
        '&atilde;': 'ã', '&ntilde;': 'ñ', '&ccedil;': 'ç',
        '&Aacute;': 'Á', '&Eacute;': 'É', '&Iacute;': 'Í', '&Oacute;': 'Ó', '&Uacute;': 'Ú',
        '&Agrave;': 'À', '&Egrave;': 'È', '&Igrave;': 'Ì', '&Ograve;': 'Ò', '&Ugrave;': 'Ù',
        '&Acirc;': 'Â', '&Ecirc;': 'Ê', '&Icirc;': 'Î', '&Ocirc;': 'Ô', '&Ucirc;': 'Û',
        '&Atilde;': 'Ã', '&Ntilde;': 'Ñ', '&Ccedil;': 'Ç'
      };
      
      for (const [entity, char] of Object.entries(htmlEntities)) {
        fixedText = fixedText.replace(new RegExp(entity, 'gi'), char);
      }
      
      return fixedText.trim();
    } catch (error) {
      console.warn('[EmailTextExtractor] Error al corregir codificación de texto:', error);
      return text; // Retornar texto original si hay error
    }
  }
} 