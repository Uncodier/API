/**
 * MailboxDetectorService - Detecta carpetas de email de manera inteligente
 * Soporte multi-proveedor (Gmail, Outlook, Yahoo, etc.) y multi-idioma
 */

export interface MailboxInfo {
  name: string;
  path: string;
  attributes?: string[];
  delimiter?: string;
  specialUse?: string;
}

export interface SentFolderResult {
  found: boolean;
  folderName?: string;
  confidence: number;
  method: 'special-use' | 'provider-specific' | 'language-mapping' | 'similarity' | 'fallback';
  provider?: string;
}

export class MailboxDetectorService {
  
  // SPECIAL-USE attributes according to RFC 6154
  private static readonly SPECIAL_USE_SENT = ['\\Sent'];
  
  // Provider-specific folder mappings
  private static readonly PROVIDER_MAPPINGS = {
    'gmail': {
      sent: ['[Gmail]/Sent Mail', 'Enviados', '[Gmail]/Elementos enviados'],
      domain: ['gmail.com', 'googlemail.com']
    },
    'outlook': {
      sent: ['Sent Items', 'Elementos enviados', 'Envoyés', 'Gesendete Elemente', 'Elementi inviati'],
      domain: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com']
    },
    'yahoo': {
      sent: ['Sent', 'Enviados', 'Envoyés', 'Gesendete', 'Inviati'],
      domain: ['yahoo.com', 'yahoo.es', 'yahoo.fr', 'yahoo.de', 'yahoo.it']
    },
    'apple': {
      sent: ['Sent', 'Enviados', 'Envoyés', 'Gesendete', 'Inviati'],
      domain: ['icloud.com', 'me.com', 'mac.com']
    }
  };
  
  // Multi-language mapping for sent folders
  private static readonly LANGUAGE_MAPPINGS: { [key: string]: number } = {
    // English
    'sent': 1.0,
    'sent items': 1.0,
    'sent mail': 1.0,
    'sent messages': 1.0,
    'outbox': 0.8,
    
    // Spanish
    'enviados': 1.0,
    'elementos enviados': 1.0,
    'correos enviados': 1.0,
    'mensajes enviados': 1.0,
    'bandeja de salida': 0.8,
    
    // French
    'envoyés': 1.0,
    'éléments envoyés': 1.0,
    'messages envoyés': 1.0,
    'courriers envoyés': 1.0,
    'boîte d\'envoi': 0.8,
    
    // German
    'gesendete elemente': 1.0,
    'gesendete': 1.0,
    'gesendete nachrichten': 1.0,
    'postausgang': 0.8,
    
    // Italian
    'posta inviata': 1.0,
    'elementi inviati': 1.0,
    'messaggi inviati': 1.0,
    'inviati': 1.0,
    'posta in uscita': 0.8,
    
    // Portuguese
    'itens enviados': 1.0,
    'enviadas': 1.0,
    'mensagens enviadas': 1.0,
    'caixa de saída': 0.8,
    
    // Dutch
    'verzonden items': 1.0,
    'verzonden': 1.0,
    'verzonden berichten': 1.0,
    'postvak uit': 0.8,
    
    // Russian (transliterated)
    'otpravlennye': 1.0,
    'otpravlennaya pochta': 1.0,
    
    // Japanese (common romanizations)
    'soushin': 1.0,
    'soushintsuumi': 1.0,
    
    // Chinese (common romanizations)
    'yifajian': 1.0,
    'songchu': 1.0
  };

  /**
   * Detecta el proveedor de email basado en la configuración
   */
  static detectProvider(host: string, user: string): string | null {
    const lowerHost = host.toLowerCase();
    const lowerUser = user.toLowerCase();
    
    for (const [provider, config] of Object.entries(this.PROVIDER_MAPPINGS)) {
      // Check by host
      if (config.domain.some(domain => lowerHost.includes(domain))) {
        return provider;
      }
      
      // Check by user email domain
      const emailDomain = lowerUser.split('@')[1];
      if (emailDomain && config.domain.includes(emailDomain)) {
        return provider;
      }
    }
    
    return null;
  }

  /**
   * Encuentra la carpeta de enviados usando SPECIAL-USE attributes
   */
  static findSentBySpecialUse(mailboxes: MailboxInfo[]): SentFolderResult {
    for (const mailbox of mailboxes) {
      if (mailbox.attributes && mailbox.specialUse) {
        if (this.SPECIAL_USE_SENT.includes(mailbox.specialUse)) {
          return {
            found: true,
            folderName: mailbox.path || mailbox.name,
            confidence: 1.0,
            method: 'special-use'
          };
        }
      }
      
      // Check attributes array for special use
      if (mailbox.attributes) {
        for (const attr of mailbox.attributes) {
          if (this.SPECIAL_USE_SENT.includes(attr)) {
            return {
              found: true,
              folderName: mailbox.path || mailbox.name,
              confidence: 1.0,
              method: 'special-use'
            };
          }
        }
      }
    }
    
    return { found: false, confidence: 0, method: 'special-use' };
  }

  /**
   * Encuentra la carpeta de enviados usando mapeo específico del proveedor
   */
  static findSentByProvider(mailboxes: MailboxInfo[], provider: string): SentFolderResult {
    const providerConfig = this.PROVIDER_MAPPINGS[provider as keyof typeof this.PROVIDER_MAPPINGS];
    if (!providerConfig) {
      return { found: false, confidence: 0, method: 'provider-specific' };
    }

    const availableNames = mailboxes.map(m => m.name);
    
    for (const sentFolder of providerConfig.sent) {
      if (availableNames.includes(sentFolder)) {
        return {
          found: true,
          folderName: sentFolder,
          confidence: 0.95,
          method: 'provider-specific',
          provider
        };
      }
    }
    
    return { found: false, confidence: 0, method: 'provider-specific', provider };
  }

  /**
   * Encuentra la carpeta de enviados usando mapeo de idiomas
   */
  static findSentByLanguageMapping(mailboxes: MailboxInfo[]): SentFolderResult {
    let bestMatch: SentFolderResult = { found: false, confidence: 0, method: 'language-mapping' };
    
    for (const mailbox of mailboxes) {
      const lowerName = mailbox.name.toLowerCase().trim();
      
      // Exact match
      if (this.LANGUAGE_MAPPINGS[lowerName]) {
        const confidence = this.LANGUAGE_MAPPINGS[lowerName];
        if (confidence > bestMatch.confidence) {
          bestMatch = {
            found: true,
            folderName: mailbox.name,
            confidence,
            method: 'language-mapping'
          };
        }
      }
    }
    
    return bestMatch;
  }

  /**
   * Encuentra la carpeta de enviados usando similitud de texto
   */
  static findSentBySimilarity(mailboxes: MailboxInfo[]): SentFolderResult {
    let bestMatch: SentFolderResult = { found: false, confidence: 0, method: 'similarity' };
    
    const sentKeywords = Object.keys(this.LANGUAGE_MAPPINGS);
    
    for (const mailbox of mailboxes) {
      const lowerName = mailbox.name.toLowerCase().trim();
      
      for (const keyword of sentKeywords) {
        const similarity = this.calculateSimilarity(lowerName, keyword);
        const baseConfidence = this.LANGUAGE_MAPPINGS[keyword];
        const adjustedConfidence = similarity * baseConfidence * 0.8; // Reduce confidence for fuzzy matches
        
        if (adjustedConfidence > bestMatch.confidence && adjustedConfidence > 0.6) {
          bestMatch = {
            found: true,
            folderName: mailbox.name,
            confidence: adjustedConfidence,
            method: 'similarity'
          };
        }
      }
    }
    
    return bestMatch;
  }

  /**
   * Calcula similitud entre dos strings usando algoritmo de Levenshtein normalizado
   */
  private static calculateSimilarity(str1: string, str2: string): number {
    const len1 = str1.length;
    const len2 = str2.length;
    
    if (len1 === 0) return len2 === 0 ? 1 : 0;
    if (len2 === 0) return 0;
    
    const matrix = Array(len1 + 1).fill(null).map(() => Array(len2 + 1).fill(null));
    
    for (let i = 0; i <= len1; i++) matrix[i][0] = i;
    for (let j = 0; j <= len2; j++) matrix[0][j] = j;
    
    for (let i = 1; i <= len1; i++) {
      for (let j = 1; j <= len2; j++) {
        const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,      // deletion
          matrix[i][j - 1] + 1,      // insertion
          matrix[i - 1][j - 1] + cost // substitution
        );
      }
    }
    
    const maxLen = Math.max(len1, len2);
    return (maxLen - matrix[len1][len2]) / maxLen;
  }

  /**
   * Fallback usando carpetas comunes
   */
  static findSentByFallback(mailboxes: MailboxInfo[]): SentFolderResult {
    const fallbackNames = ['Sent', 'Enviados', 'Sent Items', 'Outbox'];
    const availableNames = mailboxes.map(m => m.name);
    
    for (const fallbackName of fallbackNames) {
      if (availableNames.includes(fallbackName)) {
        return {
          found: true,
          folderName: fallbackName,
          confidence: 0.5,
          method: 'fallback'
        };
      }
    }
    
    return { found: false, confidence: 0, method: 'fallback' };
  }

  /**
   * Método principal para detectar carpeta de enviados
   */
  static detectSentFolder(mailboxes: MailboxInfo[], host?: string, user?: string): SentFolderResult {
    console.log(`[MailboxDetector] 🔍 Detectando carpeta de enviados entre ${mailboxes.length} carpetas...`);
    console.log(`[MailboxDetector] 📋 Carpetas disponibles:`, mailboxes.map(m => m.name));
    
    // 1. Try SPECIAL-USE attributes first (highest confidence)
    console.log(`[MailboxDetector] 🏷️ Intentando detección por SPECIAL-USE attributes...`);
    const specialUseResult = this.findSentBySpecialUse(mailboxes);
    if (specialUseResult.found && specialUseResult.confidence >= 0.9) {
      console.log(`[MailboxDetector] ✅ Carpeta encontrada por SPECIAL-USE: ${specialUseResult.folderName}`);
      return specialUseResult;
    }
    
    // 2. Try provider-specific mapping
    if (host && user) {
      const provider = this.detectProvider(host, user);
      if (provider) {
        console.log(`[MailboxDetector] 🏢 Proveedor detectado: ${provider}, intentando mapeo específico...`);
        const providerResult = this.findSentByProvider(mailboxes, provider);
        if (providerResult.found && providerResult.confidence >= 0.9) {
          console.log(`[MailboxDetector] ✅ Carpeta encontrada por proveedor ${provider}: ${providerResult.folderName}`);
          return providerResult;
        }
      }
    }
    
    // 3. Try language mapping (exact matches)
    console.log(`[MailboxDetector] 🌐 Intentando detección por mapeo de idiomas...`);
    const languageResult = this.findSentByLanguageMapping(mailboxes);
    if (languageResult.found && languageResult.confidence >= 0.8) {
      console.log(`[MailboxDetector] ✅ Carpeta encontrada por idioma: ${languageResult.folderName} (confianza: ${languageResult.confidence})`);
      return languageResult;
    }
    
    // 4. Try similarity matching
    console.log(`[MailboxDetector] 🔤 Intentando detección por similitud...`);
    const similarityResult = this.findSentBySimilarity(mailboxes);
    if (similarityResult.found && similarityResult.confidence >= 0.7) {
      console.log(`[MailboxDetector] ✅ Carpeta encontrada por similitud: ${similarityResult.folderName} (confianza: ${similarityResult.confidence})`);
      return similarityResult;
    }
    
    // 5. Last resort: fallback
    console.log(`[MailboxDetector] 🆘 Intentando detección por fallback...`);
    const fallbackResult = this.findSentByFallback(mailboxes);
    if (fallbackResult.found) {
      console.log(`[MailboxDetector] ⚠️ Carpeta encontrada por fallback: ${fallbackResult.folderName} (confianza baja)`);
      return fallbackResult;
    }
    
    console.log(`[MailboxDetector] ❌ No se pudo detectar carpeta de enviados`);
    return { found: false, confidence: 0, method: 'fallback' };
  }

  /**
   * Convierte información de carpeta de ImapFlow a MailboxInfo
   */
  static normalizeMailboxInfo(imapMailboxes: any[]): MailboxInfo[] {
    return imapMailboxes.map(mailbox => ({
      name: mailbox.name,
      path: mailbox.path || mailbox.name,
      attributes: mailbox.flags || mailbox.attributes || [],
      delimiter: mailbox.delimiter,
      specialUse: mailbox.specialUse
    }));
  }
} 