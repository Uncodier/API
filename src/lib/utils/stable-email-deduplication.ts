import crypto from 'crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';

export interface StableEmailFingerprint {
  stableHash: string;       // Hash de elementos que nunca cambian
  semanticHash: string;     // Hash del contenido semántico (texto limpio)
  timeWindow: string;       // Ventana temporal (hora) para agrupar emails similares
  recipientNormalized: string;
  subjectNormalized: string;
}

export class StableEmailDeduplicationService {
  
  /**
   * Genera fingerprint basado SOLO en elementos estables
   * (que NO cambian entre envío y recepción)
   */
  static generateStableFingerprint(email: any): StableEmailFingerprint {
    // ELEMENTOS ESTABLES (nunca cambian):
    const recipientNormalized = this.normalizeRecipient(email.to || '');
    const subjectNormalized = this.normalizeSubject(email.subject || '');
    const timeWindow = this.getTimeWindow(email.date);
    
    // CONTENIDO SEMÁNTICO (texto limpio, sin HTML ni formatting)
    const semanticContent = this.extractSemanticContent(email);
    
    // Hash estable: recipient + subject + hora (sin minutos/segundos)
    const stableElements = `${recipientNormalized}:${subjectNormalized}:${timeWindow}`;
    const stableHash = this.generateHash(stableElements);
    
    // Hash semántico: solo las palabras principales del contenido
    const semanticHash = this.generateHash(semanticContent);
    
    return {
      stableHash,
      semanticHash,
      timeWindow,
      recipientNormalized,
      subjectNormalized
    };
  }

  /**
   * Extrae SOLO el contenido semántico (palabras clave)
   * ignorando formato, HTML, headers, etc.
   */
  private static extractSemanticContent(email: any): string {
    let rawText = '';
    
    // Prioridad: texto plano > HTML convertido
    if (email.text && typeof email.text === 'string') {
      rawText = email.text;
    } else if (email.body?.text) {
      rawText = email.body.text;
    } else if (email.body && typeof email.body === 'string') {
      rawText = email.body;
    } else if (email.html) {
      rawText = this.htmlToPlainText(email.html);
    } else if (email.body?.html) {
      rawText = this.htmlToPlainText(email.body.html);
    }
    
    // Extraer solo palabras significativas (semántica)
    return this.extractKeyWords(rawText);
  }

  /**
   * Convierte HTML a texto plano de manera robusta
   */
  private static htmlToPlainText(html: string): string {
    return html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '') // Remover scripts
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')   // Remover CSS
      .replace(/<[^>]*>/g, ' ')                      // Remover todas las tags
      .replace(/&[a-z]+;/gi, ' ')                   // Remover entidades HTML
      .replace(/\s+/g, ' ')                         // Normalizar espacios
      .trim();
  }

  /**
   * Normalizar destinatario (extraer email limpio)
   */
  private static normalizeRecipient(to: string): string {
    const emailMatch = to.match(/<([^>]+)>/);
    const email = emailMatch ? emailMatch[1] : to;
    return email.toLowerCase().trim().replace(/\s+/g, '');
  }

  /**
   * Normalizar subject (sin Re:, Fwd:, etc.)
   */
  private static normalizeSubject(subject: string): string {
    return subject
      .replace(/^(Re|RE|Fwd|FWD|Fw|FW):\s*/gi, '')
      .replace(/\s+/g, ' ')
      .toLowerCase()
      .trim();
  }

  /**
   * Obtener ventana temporal (solo hora, ignorar minutos/segundos)
   */
  private static getTimeWindow(dateString?: string): string {
    const date = dateString ? new Date(dateString) : new Date();
    // Solo año-mes-día-hora (ignorar minutos y segundos)
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}-${String(date.getHours()).padStart(2, '0')}`;
  }

  /**
   * Genera hash SHA-256
   */
  private static generateHash(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  }

  /**
   * Verifica si un email es duplicado usando validación estable
   */
  static async isEmailDuplicateStable(
    email: any,
    conversationId: string,
    leadId: string
  ): Promise<{ isDuplicate: boolean; reason?: string; existingMessageId?: string }> {
    try {
      const fingerprint = this.generateStableFingerprint(email);
      
      console.log(`[STABLE_DEDUP] 🔍 Verificando email con fingerprint:`, {
        stableHash: fingerprint.stableHash.substring(0, 8) + '...',
        semanticHash: fingerprint.semanticHash.substring(0, 8) + '...',
        timeWindow: fingerprint.timeWindow,
        recipient: fingerprint.recipientNormalized,
        subject: fingerprint.subjectNormalized.substring(0, 50) + '...'
      });

      // 1. PRIMERA VERIFICACIÓN: Hash estable exacto (mismo recipient + subject + hora)
      const { data: exactMatch } = await supabaseAdmin
        .from('messages')
        .select('id, custom_data')
        .eq('conversation_id', conversationId)
        .eq('lead_id', leadId)
        .filter('custom_data->>stable_hash', 'eq', fingerprint.stableHash)
        .limit(1);

      if (exactMatch && exactMatch.length > 0) {
        console.log(`[STABLE_DEDUP] ✅ Duplicado detectado por hash estable exacto: ${exactMatch[0].id}`);
        return { 
          isDuplicate: true, 
          reason: 'stable_hash_exact_match',
          existingMessageId: exactMatch[0].id 
        };
      }

      // 2. SEGUNDA VERIFICACIÓN: Contenido semántico + destinatario (últimas 24 horas)
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      
      const { data: semanticMatches } = await supabaseAdmin
        .from('messages')
        .select('id, custom_data, content')
        .eq('conversation_id', conversationId)
        .eq('lead_id', leadId)
        .filter('custom_data->>recipient_normalized', 'eq', fingerprint.recipientNormalized)
        .gte('created_at', yesterday)
        .limit(10);

      if (semanticMatches && semanticMatches.length > 0) {
        for (const match of semanticMatches) {
          const existingSemanticHash = match.custom_data?.semantic_hash;
          
          // Verificar si el contenido semántico es idéntico
          if (existingSemanticHash === fingerprint.semanticHash) {
            console.log(`[STABLE_DEDUP] ✅ Duplicado detectado por contenido semántico: ${match.id}`);
            return { 
              isDuplicate: true, 
              reason: 'semantic_content_match',
              existingMessageId: match.id 
            };
          }
          
          // REMOVIDO: Verificación de similitud problemática con hashes SHA-256
        }
      }

      // 3. TERCERA VERIFICACIÓN: Subject idéntico + destinatario + ventana temporal amplia (2 horas)
      const currentTime = new Date(email.date || Date.now());
      const adjacentTimeWindows = this.getAdjacentTimeWindows(currentTime);

      for (const timeWindow of adjacentTimeWindows) {
        const { data: timeWindowMatches } = await supabaseAdmin
          .from('messages')
          .select('id, custom_data')
          .eq('conversation_id', conversationId)
          .eq('lead_id', leadId)
          .filter('custom_data->>recipient_normalized', 'eq', fingerprint.recipientNormalized)
          .filter('custom_data->>subject_normalized', 'eq', fingerprint.subjectNormalized)
          .filter('custom_data->>time_window', 'eq', timeWindow)
          .limit(1);

        if (timeWindowMatches && timeWindowMatches.length > 0) {
          console.log(`[STABLE_DEDUP] ✅ Duplicado detectado por subject + recipient + time window: ${timeWindowMatches[0].id}`);
          return { 
            isDuplicate: true, 
            reason: 'subject_recipient_timewindow_match',
            existingMessageId: timeWindowMatches[0].id 
          };
        }
      }

      console.log(`[STABLE_DEDUP] ✅ Email no es duplicado - todas las verificaciones pasaron`);
      return { isDuplicate: false };

    } catch (error) {
      console.error('[STABLE_DEDUP] Error en verificación de duplicados:', error);
      return { isDuplicate: false }; // En caso de error, no bloquear
    }
  }

  /**
   * Obtiene ventanas temporales adyacentes de manera segura
   */
  private static getAdjacentTimeWindows(date: Date): string[] {
    const currentWindow = this.getTimeWindow(date.toISOString());
    const windows = [currentWindow];
    
    // Hora anterior
    const prevHour = new Date(date.getTime() - 60 * 60 * 1000);
    windows.push(this.getTimeWindow(prevHour.toISOString()));
    
    // Hora siguiente
    const nextHour = new Date(date.getTime() + 60 * 60 * 1000);
    windows.push(this.getTimeWindow(nextHour.toISOString()));
    
    return Array.from(new Set(windows)); // Remover duplicados
  }

  /**
   * Extrae solo palabras clave semánticamente importantes (mejorado)
   */
  private static extractKeyWords(text: string): string {
    return text
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // Normalizar acentos
      .replace(/[^\w\s]/g, ' ')      // Solo letras, números y espacios
      .replace(/\b(el|la|los|las|un|una|de|del|en|con|por|para|que|y|o|si|no|es|son|esta|este|esto|muy|mas|pero|como|cuando|donde|porque|desde|hasta|sobre|entre|durante|antes|despues|ahora|hoy|ayer|mañana|siempre|nunca|quizas|tal|vez|email|correo|mensaje|saludo|gracias|atentamente|the|and|or|but|with|for|from|this|that|have|has|will|was|were|been|being|would|could|should|might|must|can|may|do|does|did|done|get|got|give|gave|take|took|make|made|see|saw|know|knew|think|thought|feel|felt|come|came|go|went|want|wanted|need|needed|use|used|work|worked|say|said|tell|told|ask|asked|look|looked|find|found)\b/g, ' ') // Remover palabras comunes en español e inglés
      .replace(/\b\w{1,2}\b/g, ' ')         // Remover palabras muy cortas
      .replace(/\b\d+\b/g, ' ')             // Remover números standalone
      .replace(/\s+/g, ' ')                 // Normalizar espacios
      .trim()
      .split(' ')
      .filter(word => word.length > 2)      // Solo palabras de 3+ caracteres
      .sort()                               // Ordenar para consistencia
      .slice(0, 20)                         // Máximo 20 palabras clave
      .join(' ');
  }
} 