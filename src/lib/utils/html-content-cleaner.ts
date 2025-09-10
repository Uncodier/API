/**
 * Comprehensive text cleaning utilities for RSS feeds and HTML content
 * Optimizado para limpiar contenido de emails y feeds RSS
 */

/**
 * Clean HTML entities and special characters
 */
function cleanHtmlEntities(text: string): string {
  if (!text) return text;
  
  let cleaned = text;
  
  // Common HTML entities
  const entities: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&apos;': "'",
    '&nbsp;': ' ',
    '&ndash;': '–',
    '&mdash;': '—',
    '&lsquo;': "'",
    '&rsquo;': "'",
    '&ldquo;': '"',
    '&rdquo;': '"',
    '&hellip;': '...',
    '&copy;': '©',
    '&reg;': '®',
    '&trade;': '™'
  };
  
  // Replace known entities
  for (const [entity, replacement] of Object.entries(entities)) {
    cleaned = cleaned.replace(new RegExp(entity, 'g'), replacement);
  }
  
  // Remove remaining HTML entities (&#xxx; format)
  cleaned = cleaned.replace(/&#\d+;/g, '');
  cleaned = cleaned.replace(/&#x[0-9a-fA-F]+;/g, '');
  
  // Remove any remaining & entities
  cleaned = cleaned.replace(/&[a-zA-Z0-9]+;/g, '');
  
  return cleaned;
}

/**
 * Remove URLs and links from text
 */
function removeUrls(text: string): string {
  if (!text) return text;
  
  let cleaned = text;
  
  // Remove HTTP/HTTPS URLs
  cleaned = cleaned.replace(/https?:\/\/[^\s<>"']+/gi, '');
  
  // Remove www URLs
  cleaned = cleaned.replace(/www\.[^\s<>"']+/gi, '');
  
  // Remove email addresses that look like URLs
  cleaned = cleaned.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '');
  
  return cleaned;
}

/**
 * Remove source attribution patterns commonly found in RSS feeds
 */
function removeSourceAttribution(text: string): string {
  if (!text) return text;
  
  let cleaned = text;
  
  // Common source attribution patterns
  const attributionPatterns = [
    /Fuente: [^.]+\./gi,
    /Source: [^.]+\./gi,
    /Por: [^.]+\./gi,
    /By: [^.]+\./gi,
    /- [A-Z][a-zA-Z\s]+$/gi, // Ending with "- Source Name"
    /\([A-Z][a-zA-Z\s]+\)$/gi, // Ending with "(Source Name)"
    /Vía: [^.]+\./gi,
    /Via: [^.]+\./gi,
    /Según: [^.]+\./gi,
    /According to: [^.]+\./gi,
    /Reporta: [^.]+\./gi,
    /Reports: [^.]+\./gi,
    /Imagen: [^.]+\./gi,
    /Image: [^.]+\./gi,
    /Foto: [^.]+\./gi,
    /Photo: [^.]+\./gi
  ];
  
  for (const pattern of attributionPatterns) {
    cleaned = cleaned.replace(pattern, '');
  }
  
  return cleaned;
}

/**
 * Normalize whitespace and special characters
 */
function normalizeWhitespace(text: string): string {
  if (!text) return text;
  
  let cleaned = text;
  
  // Replace multiple consecutive whitespace with single space
  cleaned = cleaned.replace(/\s+/g, ' ');
  
  // Replace multiple consecutive newlines with single newline
  cleaned = cleaned.replace(/\n\s*\n/g, '\n');
  
  // Remove whitespace at beginning and end of lines
  cleaned = cleaned.replace(/^\s+|\s+$/gm, '');
  
  // Remove special unicode whitespace characters
  cleaned = cleaned.replace(/[\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000\uFEFF]/g, ' ');
  
  // Normalize quotes
  cleaned = cleaned.replace(/[""]/g, '"');
  cleaned = cleaned.replace(/['']/g, "'");
  
  // Remove zero-width characters
  cleaned = cleaned.replace(/[\u200B-\u200D\uFEFF]/g, '');
  
  return cleaned.trim();
}

/**
 * Remove common unwanted phrases from RSS feeds
 */
function removeUnwantedPhrases(text: string): string {
  if (!text) return text;
  
  let cleaned = text;
  
  // Common unwanted phrases in RSS feeds
  const unwantedPhrases = [
    /Leer más\.{0,3}$/gi,
    /Read more\.{0,3}$/gi,
    /Continúa leyendo\.{0,3}$/gi,
    /Continue reading\.{0,3}$/gi,
    /Ver más\.{0,3}$/gi,
    /See more\.{0,3}$/gi,
    /\[Leer más\]/gi,
    /\[Read more\]/gi,
    /\[...\]/g,
    /\.{3,}/g, // Multiple dots
    /Click here.*/gi,
    /Haz clic aquí.*/gi,
    /Subscribe.*/gi,
    /Suscríbete.*/gi,
    /Follow us.*/gi,
    /Síguenos.*/gi,
    /Share this.*/gi,
    /Comparte esto.*/gi,
    /Advertisement/gi,
    /Publicidad/gi,
    /Sponsored/gi,
    /Patrocinado/gi
  ];
  
  for (const phrase of unwantedPhrases) {
    cleaned = cleaned.replace(phrase, '');
  }
  
  return cleaned;
}

/**
 * Final cleanup and validation
 */
function finalCleanup(text: string): string {
  if (!text) return '';
  
  let cleaned = text;
  
  // Remove any remaining HTML-like patterns
  cleaned = cleaned.replace(/<[^>]*>/g, '');
  
  // Remove any remaining bracketed content that looks like metadata
  cleaned = cleaned.replace(/\[[^\]]*\]/g, '');
  
  // Remove excessive punctuation
  cleaned = cleaned.replace(/[.]{3,}/g, '...');
  cleaned = cleaned.replace(/[!]{2,}/g, '!');
  cleaned = cleaned.replace(/[?]{2,}/g, '?');
  
  // Final whitespace normalization
  cleaned = normalizeWhitespace(cleaned);
  
  // Remove very short content (likely not meaningful)
  if (cleaned.length < 10) {
    return '';
  }
  
  // Remove content that's mostly punctuation or special characters
  const alphaNumericRatio = (cleaned.match(/[a-zA-Z0-9]/g) || []).length / cleaned.length;
  if (alphaNumericRatio < 0.3) {
    return '';
  }
  
  return cleaned;
}

/**
 * Advanced HTML content cleaner that removes all HTML tags, entities, and unwanted content
 * Specifically designed for cleaning Google News RSS feed content and email content
 */
export function cleanHtmlContent(htmlString: string): string {
  // Avoid logging content for privacy; keep minimal metadata only
  console.log('🧽 [cleanHtmlContent] Input length:', (htmlString || '').length)
  
  if (!htmlString || typeof htmlString !== 'string') return ''
  
  let cleaned = htmlString.trim()
  
  // Step 1: Handle CDATA sections first
  cleaned = cleaned.replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1')
  
  // Step 2: Extract text from common HTML elements before removing them
  // Extract text from <a> tags (preserve the link text)
  cleaned = cleaned.replace(/<a[^>]*>(.*?)<\/a>/gi, '$1')
  
  // Extract text from <b>, <strong>, <i>, <em> tags
  cleaned = cleaned.replace(/<(b|strong|i|em)[^>]*>(.*?)<\/\1>/gi, '$2')
  
  // Extract text from header tags
  cleaned = cleaned.replace(/<(h[1-6])[^>]*>(.*?)<\/\1>/gi, '$2')
  
  // Extract text from paragraph tags
  cleaned = cleaned.replace(/<p[^>]*>(.*?)<\/p>/gi, '$1 ')
  
  // Extract text from div and span tags
  cleaned = cleaned.replace(/<(div|span)[^>]*>(.*?)<\/\1>/gi, '$2 ')
  
  // Step 3: Remove problematic tags completely (including content)
  // Remove font tags (often contain source attribution we don't want)
  cleaned = cleaned.replace(/<font[^>]*>.*?<\/font>/gi, '')
  
  // Remove script and style tags with their content
  cleaned = cleaned.replace(/<(script|style)[^>]*>.*?<\/\1>/gi, '')
  
  // Remove comments
  cleaned = cleaned.replace(/<!--.*?-->/g, '')
  
  // Step 4: Remove all remaining HTML tags
  cleaned = cleaned.replace(/<[^>]*>/g, '')
  
  // Step 5: Clean HTML entities
  cleaned = cleanHtmlEntities(cleaned)
  
  // Step 6: Remove URLs and links
  cleaned = removeUrls(cleaned)
  
  // Step 7: Clean up source attribution patterns
  cleaned = removeSourceAttribution(cleaned)
  
  // Step 8: Normalize whitespace and special characters
  cleaned = normalizeWhitespace(cleaned)
  
  // Step 9: Remove common unwanted phrases
  cleaned = removeUnwantedPhrases(cleaned)
  
  // Step 10: Final cleanup and validation
  cleaned = finalCleanup(cleaned)
  
  console.log('✨ [cleanHtmlContent] Output length:', cleaned.length)
  return cleaned
}

/**
 * Simplified version for basic HTML cleaning when full comprehensive cleaning is not needed
 */
export function cleanHtmlBasic(htmlString: string): string {
  if (!htmlString || typeof htmlString !== 'string') return '';
  
  let cleaned = htmlString.trim();
  
  // Remove HTML tags
  cleaned = cleaned.replace(/<[^>]*>/g, ' ');
  
  // Clean basic HTML entities
  cleaned = cleanHtmlEntities(cleaned);
  
  // Normalize whitespace
  cleaned = normalizeWhitespace(cleaned);
  
  return cleaned;
}