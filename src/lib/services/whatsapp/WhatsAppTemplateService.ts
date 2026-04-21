import { supabaseAdmin } from '@/lib/database/supabase-client';
import { extractMergeTokens } from '@/lib/messaging/lead-merge-fields';

export interface WhatsAppTemplateResult {
  success: boolean;
  templateSid?: string;
  messageId?: string;
  requiresTemplate?: boolean;
  withinResponseWindow?: boolean;
  error?: {
    code: string;
    message: string;
  };
}

export interface CreateTemplateResult {
  success: boolean;
  templateSid?: string;
  templatedBody?: string;
  placeholderMap?: string[];
  error?: string;
}

export interface FindExistingTemplateResult {
  templateSid?: string;
  templateName?: string;
  templatedBody?: string;
  placeholderMap?: string[];
}

export interface WhatsAppConversationWindow {
  withinWindow: boolean;
  lastMessageTime?: Date;
  hoursElapsed?: number;
}

export class WhatsAppTemplateService {
  
  /**
   * Verifica si una conversación está dentro de la ventana de respuesta (24 horas)
   */
  static async checkResponseWindow(conversationId: string | null, phoneNumber: string, siteId: string): Promise<WhatsAppConversationWindow> {
    try {
      console.log(`🕐 [WhatsAppTemplateService] Verificando ventana de respuesta para conversación: ${conversationId || 'nueva'}`);
      
      // Si no hay conversation_id, es una conversación nueva - fuera de ventana
      if (!conversationId) {
        console.log(`📱 [WhatsAppTemplateService] Conversación nueva - fuera de ventana de respuesta`);
        return { withinWindow: false };
      }
      
      // Buscar el último mensaje del usuario en esta conversación
      const { data: lastUserMessage, error } = await supabaseAdmin
        .from('messages')
        .select('created_at, role, custom_data')
        .eq('conversation_id', conversationId)
        .eq('role', 'user') // Solo mensajes del usuario
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
      
      if (error || !lastUserMessage) {
        console.log(`⚠️ [WhatsAppTemplateService] No se encontró último mensaje del usuario, asumiendo fuera de ventana`);
        return { withinWindow: false };
      }
      
      const lastMessageTime = new Date(lastUserMessage.created_at);
      const now = new Date();
      const hoursElapsed = (now.getTime() - lastMessageTime.getTime()) / (1000 * 60 * 60);
      
      const withinWindow = hoursElapsed <= 24;
      
      console.log(`⏰ [WhatsAppTemplateService] Análisis de ventana:`, {
        lastMessageTime: lastMessageTime.toISOString(),
        hoursElapsed: hoursElapsed.toFixed(2),
        withinWindow
      });
      
      return {
        withinWindow,
        lastMessageTime,
        hoursElapsed
      };
      
    } catch (error) {
      console.error(`❌ [WhatsAppTemplateService] Error verificando ventana de respuesta:`, error);
      // En caso de error, asumir que está fuera de ventana para ser conservadores
      return { withinWindow: false };
    }
  }
  
  /**
   * Crea un Twilio Content Template automáticamente para WhatsApp.
   *
   * The incoming `message` may contain merge tokens ({{lead.name}}, {{site.name}}, ...).
   * They are rewritten to Twilio numeric placeholders ({{1}}, {{2}}, ...) before the
   * template is submitted. The canonical token map is persisted alongside the template
   * so callers can later resolve per-lead ContentVariables.
   */
  static async createTemplate(
    message: string,
    accountSid: string,
    authToken: string,
    siteId: string
  ): Promise<CreateTemplateResult> {
    try {
      console.log(`📝 [WhatsAppTemplateService] Creando Content Template de Twilio para site: ${siteId}`);
      
      const timestamp = Date.now();
      const templateName = `auto_template_${siteId.substring(0, 8)}_${timestamp}`;
      
      const { templated, tokens } = extractMergeTokens(message);
      const templateContent = this.prepareTemplateContent(templated);
      
      console.log(`🏗️ [WhatsAppTemplateService] Content Template preparado:`, {
        name: templateName,
        contentLength: templateContent.length,
        contentPreview: templateContent.substring(0, 100) + '...'
      });
      
      // URL correcta de la Content API de Twilio
      const apiUrl = `https://content.twilio.com/v1/Content`;
      
      // Crear las credenciales de autenticación básica
      const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
      
      // Preparar el contenido del template para Content API específico para WhatsApp
      const templateBody = {
        friendly_name: templateName,
        language: 'es',
        types: {
          'twilio/text': {
            body: templateContent
          }
        }
      };
      
      console.log('📋 [WhatsAppTemplateService] Template body preparado:', JSON.stringify(templateBody, null, 2));
      
      console.log('🔐 [WhatsAppTemplateService] Datos de creación:', {
        url: apiUrl,
        templateName,
        bodyLength: templateContent.length
      });
      
      // Implementar reintentos para manear problemas de conectividad
      let response;
      let lastError;
      const maxRetries = 3;
      const retryDelay = 1000; // 1 segundo
      
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          console.log(`🔄 [WhatsAppTemplateService] Intento ${attempt}/${maxRetries} de llamada a Content API`);
          
          response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
              'Authorization': `Basic ${credentials}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(templateBody),
            // Agregar timeout para evitar llamadas colgadas
            signal: AbortSignal.timeout(30000) // 30 segundos timeout
          });
          
          // Si la respuesta es exitosa, salir del loop
          break;
          
        } catch (error) {
          lastError = error;
          console.warn(`⚠️ [WhatsAppTemplateService] Intento ${attempt} falló:`, {
            error: error instanceof Error ? error.message : String(error),
            code: error && typeof error === 'object' && 'code' in error ? (error as any).code : 'unknown',
            cause: error && typeof error === 'object' && 'cause' in error ? (error as any).cause : undefined
          });
          
          // Si es el último intento, no esperar
          if (attempt < maxRetries) {
            console.log(`⏳ [WhatsAppTemplateService] Esperando ${retryDelay}ms antes del siguiente intento...`);
            await new Promise(resolve => setTimeout(resolve, retryDelay));
          }
        }
      }
      
      // Si después de todos los intentos no hay respuesta, lanzar el último error
      if (!response) {
        console.error('❌ [WhatsAppTemplateService] Error en creación de Content Template:', lastError);
        
        // Proporcionar error más descriptivo basado en el tipo de error
        let errorMessage = 'Failed to connect to Twilio Content API';
        if (lastError && typeof lastError === 'object' && 'code' in lastError && (lastError as any).code === 'ENOTFOUND') {
          errorMessage = 'DNS resolution failed for content.twilio.com. Please check network connectivity.';
        } else if (lastError && typeof lastError === 'object' && 'name' in lastError && (lastError as any).name === 'TimeoutError') {
          errorMessage = 'Request timeout. Twilio Content API is not responding.';
        } else if (lastError && typeof lastError === 'object' && 'code' in lastError && (lastError as any).code === 'ECONNREFUSED') {
          errorMessage = 'Connection refused by Twilio Content API.';
        }
        
        throw new Error(errorMessage);
      }
      
      if (!response.ok) {
        const errorData = await response.json();
        console.error(`❌ [WhatsAppTemplateService] Error creando Content Template:`, errorData);
        return {
          success: false,
          error: `Failed to create Content Template: ${errorData.message || response.statusText}`
        };
      }
      
      const templateData = await response.json();
      
      console.log(`✅ [WhatsAppTemplateService] Content Template creado exitosamente:`, {
        sid: templateData.sid,
        name: templateName,
        url: templateData.url
      });
      
      // IMPORTANTE: Someter el template para aprobación de WhatsApp automáticamente
      console.log(`📋 [WhatsAppTemplateService] Sometiendo template para aprobación de WhatsApp...`);
      const approvalResult = await this.submitTemplateForWhatsAppApproval(
        templateData.sid,
        templateName,
        accountSid,
        authToken
      );
      
      if (approvalResult.success) {
        console.log(`✅ [WhatsAppTemplateService] Template sometido para aprobación:`, approvalResult);
      } else {
        console.warn(`⚠️ [WhatsAppTemplateService] Error sometiendo para aprobación:`, approvalResult.error);
      }
      
      // Guardar el template en nuestra base de datos para referencia futura
      await this.saveTemplateReference({
        templateSid: templateData.sid,
        templateName: templateName,
        content: templateContent,
        originalMessage: message,
        siteId: siteId,
        accountSid: accountSid,
        templatedBody: templateContent,
        placeholderMap: tokens,
      });
      
      return {
        success: true,
        templateSid: templateData.sid,
        templatedBody: templateContent,
        placeholderMap: tokens,
      };
      
    } catch (error) {
      console.error(`❌ [WhatsAppTemplateService] Error en creación de Content Template:`, error);
      
      // Proporcionar información más específica del error
      let errorMessage = 'Unknown error creating Content Template';
      let errorDetails = '';
      
      if (error instanceof Error) {
        errorMessage = error.message;
        
        // Agregar detalles específicos según el tipo de error
        if (error.message.includes('DNS resolution failed')) {
          errorDetails = ' This is typically caused by network connectivity issues or DNS problems. Please check your internet connection and try again.';
        } else if (error.message.includes('Request timeout')) {
          errorDetails = ' The Twilio API is taking too long to respond. This might be a temporary issue with Twilio services.';
        } else if (error.message.includes('Connection refused')) {
          errorDetails = ' The connection to Twilio was refused. This might indicate firewall issues or Twilio service problems.';
        } else if (error.message.includes('fetch failed')) {
          errorDetails = ' General network failure. Please verify your internet connection and Twilio service status.';
        }
      }
      
      return {
        success: false,
        error: errorMessage + errorDetails
      };
    }
  }
  
  /**
   * Envía un mensaje usando un Twilio Content Template.
   *
   * When the template uses numeric placeholders ({{1}}, {{2}}, ...), callers must
   * supply `contentVariables` as a `{ "1": "value", "2": "value" }` map; the values
   * are forwarded to Twilio as `ContentVariables` (JSON-encoded).
   */
  static async sendMessageWithTemplate(
    phoneNumber: string,
    templateSid: string,
    accountSid: string,
    authToken: string,
    fromNumber: string,
    originalMessage: string,
    messagingServiceSidOverride?: string,
    contentVariables?: Record<string, string>
  ): Promise<{ success: boolean; messageId?: string; error?: string; errorCode?: number; errorType?: string; suggestion?: string }> {
    try {
      console.log(`📤 [WhatsAppTemplateService] Enviando mensaje con Content Template: ${templateSid}`);
      
      // URL de la API de Twilio para enviar mensajes
      const apiUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
      
      // Crear las credenciales de autenticación básica
      const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
      
      // Content Templates para WhatsApp REQUIEREN Messaging Service
      // Usar override si se proporciona (preferido, site-specific); fallback al método existente
      const messagingServiceSid = messagingServiceSidOverride || await this.getMessagingServiceSid(accountSid);
      
      // Preparar el cuerpo de la solicitud con Content Template
      const formData = new URLSearchParams();
      
      if (messagingServiceSid) {
        // Usar Messaging Service (REQUERIDO para Content Templates de WhatsApp)
        formData.append('MessagingServiceSid', messagingServiceSid);
        console.log(`📋 [WhatsAppTemplateService] Usando Messaging Service: ${messagingServiceSid}`);
      } else {
        // Fallback a From (puede no funcionar con Content Templates)
        formData.append('From', `whatsapp:${fromNumber}`);
        console.warn(`⚠️ [WhatsAppTemplateService] No se encontró Messaging Service, usando From`);
      }
      
      formData.append('To', `whatsapp:${phoneNumber}`);
      formData.append('ContentSid', templateSid); // Usar el Content Template

      // If the template has numeric placeholders ({{1}}, {{2}}...), Twilio requires
      // a `ContentVariables` JSON map. Omit the field for plain-text templates.
      if (contentVariables && Object.keys(contentVariables).length > 0) {
        formData.append('ContentVariables', JSON.stringify(contentVariables));
        console.log(`🧩 [WhatsAppTemplateService] ContentVariables:`, {
          keys: Object.keys(contentVariables),
          count: Object.keys(contentVariables).length,
        });
      }
      
      // CRÍTICO: Verificar estado del template antes de enviar
      console.log('🔍 [WhatsAppTemplateService] Verificando estado final del template antes de envío...');
      const approvalStatus = await this.checkTemplateApprovalStatus(templateSid, accountSid, authToken);
      console.log('📊 [WhatsAppTemplateService] Estado de aprobación antes de envío:', {
        templateSid,
        approved: approvalStatus.approved,
        status: approvalStatus.status,
        error: approvalStatus.error
      });

      // 🚨 NO ENVIAR SI EL TEMPLATE NO ESTÁ APROBADO
      if (!approvalStatus.approved) {
        console.warn('🚨 [WhatsAppTemplateService] Template no aprobado inicialmente');
        console.warn('📋 [WhatsAppTemplateService] Estado actual:', approvalStatus.status);
        
        // Para templates recién creados con status 'received' o 'pending', esperamos un poco y reintentamos
        if (approvalStatus.status === 'received' || approvalStatus.status === 'pending') {
          console.log('⏳ [WhatsAppTemplateService] Template en proceso, esperando aprobación (60s con checks cada 15s)...');
          
          let retryApprovalStatus = approvalStatus;
          const maxWaitTime = 60000; // 60 segundos
          const checkInterval = 15000; // 15 segundos
          const maxChecks = Math.floor(maxWaitTime / checkInterval);
          
          for (let i = 0; i < maxChecks; i++) {
            console.log(`⏳ [WhatsAppTemplateService] Check ${i + 1}/${maxChecks} - Esperando ${checkInterval/1000}s...`);
            await new Promise(resolve => setTimeout(resolve, checkInterval));
            
            // Verificar estado
            retryApprovalStatus = await this.checkTemplateApprovalStatus(templateSid, accountSid, authToken);
            console.log(`📊 [WhatsAppTemplateService] Check ${i + 1} - Estado:`, {
              status: retryApprovalStatus.status,
              approved: retryApprovalStatus.approved
            });
            
            // Si ya está aprobado, salir del loop
            if (retryApprovalStatus.approved) {
              console.log(`✅ [WhatsAppTemplateService] Template aprobado en check ${i + 1}!`);
              break;
            }
          }
          
          console.log('📊 [WhatsAppTemplateService] Estado después de retry:', {
            templateSid,
            approved: retryApprovalStatus.approved,
            status: retryApprovalStatus.status,
            previousStatus: approvalStatus.status
          });
          
          if (retryApprovalStatus.approved) {
            console.log('✅ [WhatsAppTemplateService] Template aprobado después de espera, continuando...');
            // Continúa con el envío
          } else {
            console.warn('⏰ [WhatsAppTemplateService] Template aún no aprobado después de 60s');
            return {
              success: false,
              error: `Template not approved after waiting 60s. Status: ${retryApprovalStatus.status}. Please try again in a few minutes.`
            };
          }
        } else {
          // Para otros estados (rejected, etc.), no esperar
          return {
            success: false,
            error: `Template not approved for WhatsApp. Status: ${approvalStatus.status}. Please wait for approval or use a pre-approved template.`
          };
        }
      }

      console.log('✅ [WhatsAppTemplateService] Template aprobado, procediendo con envío...');

      console.log(`🔐 [WhatsAppTemplateService] Datos de envío con Content Template:`, {
        from: messagingServiceSid ? undefined : `whatsapp:${fromNumber}`,
        messagingServiceSid: messagingServiceSid || undefined,
        to: `whatsapp:${phoneNumber}`,
        contentSid: templateSid,
        templateApproved: approvalStatus.approved,
        usingMessagingService: !!messagingServiceSid
      });
      
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formData.toString()
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        const twilioErrorCode = errorData.code;
        const errorMessage = errorData.message || response.statusText;
        
        console.error(`❌ [WhatsAppTemplateService] Error enviando con Content Template:`, {
          status: response.status,
          statusText: response.statusText,
          twilioErrorCode,
          errorMessage,
          fullError: errorData,
          templateSid,
          templateApproved: approvalStatus.approved,
          contentSid: templateSid,
          to: `whatsapp:${phoneNumber}`,
          from: messagingServiceSid ? 'MessagingService' : `whatsapp:${fromNumber}`
        });
        
        // Manejo específico de errores de Twilio/WhatsApp
        const errorInfo = this.getTwilioErrorInfo(twilioErrorCode);
        
        console.error(`🚨 [WhatsAppTemplateService] ERROR ${twilioErrorCode}: ${errorInfo.description}`);
        console.error(`💡 [WhatsAppTemplateService] Sugerencia: ${errorInfo.suggestion}`);
        
        return {
          success: false,
          error: `${errorInfo.description}: ${errorMessage}`,
          errorCode: twilioErrorCode,
          errorType: errorInfo.type,
          suggestion: errorInfo.suggestion
        };
      }
      
      const responseData = await response.json();
      
      console.log(`✅ [WhatsAppTemplateService] Mensaje enviado con Content Template:`, {
        messageId: responseData.sid,
        status: responseData.status,
        contentSid: templateSid
      });
      
      // Incrementar contador de uso del template
      this.incrementTemplateUsage(templateSid).catch((error: any) => {
        console.warn('⚠️ [WhatsAppTemplateService] Error incrementando uso de template:', error);
      });
      
      return {
        success: true,
        messageId: responseData.sid
      };
      
    } catch (error) {
      console.error(`❌ [WhatsAppTemplateService] Error enviando con Content Template:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error sending with Content Template'
      };
    }
  }
  
  /**
   * Busca un template existente para un mensaje similar.
   *
   * Matching strategy (in order of precedence):
   *  1) Exact match on `templated_body` (the body with numeric placeholders).
   *     This guarantees deduplication across per-lead sends of the same campaign,
   *     since per-lead variance is captured in ContentVariables, not in the body.
   *  2) Fallback to word-overlap similarity on the templated body.
   */
  static async findExistingTemplate(
    message: string,
    siteId: string,
    accountSid: string
  ): Promise<FindExistingTemplateResult> {
    try {
      console.log(`🔍 [WhatsAppTemplateService] Buscando template existente para site: ${siteId}`);
      
      const { templated } = extractMergeTokens(message);
      const preparedTemplated = this.prepareTemplateContent(templated);
      
      const { data: templates, error } = await supabaseAdmin
        .from('whatsapp_templates')
        .select('*')
        .eq('site_id', siteId)
        .eq('account_sid', accountSid)
        .order('created_at', { ascending: false })
        .limit(10);
      
      if (error) {
        console.warn(`⚠️ [WhatsAppTemplateService] Error buscando templates en BD:`, error);
        return {};
      }
      
      if (!templates || templates.length === 0) {
        console.log(`📝 [WhatsAppTemplateService] No se encontraron templates previos`);
        return {};
      }
      
      const exactMatch = templates.find(t =>
        typeof t.templated_body === 'string' && t.templated_body === preparedTemplated,
      );
      
      const similarTemplate = exactMatch ?? templates.find(template => {
        const candidate = (template.templated_body as string | undefined) ?? template.content ?? template.original_message ?? '';
        const similarity = this.calculateSimilarity(preparedTemplated, candidate);
        return similarity > 0.8;
      });
      
      if (similarTemplate) {
        const placeholderMap = Array.isArray(similarTemplate.placeholder_map)
          ? (similarTemplate.placeholder_map as string[])
          : undefined;
        console.log(`♻️ [WhatsAppTemplateService] Template reutilizable encontrado:`, {
          templateSid: similarTemplate.template_sid,
          templateName: similarTemplate.template_name,
          exact: !!exactMatch,
          hasPlaceholderMap: !!placeholderMap,
        });
        
        this.incrementTemplateUsage(similarTemplate.template_sid).catch((error: any) => {
          console.warn('⚠️ [WhatsAppTemplateService] Error incrementando uso de template:', error);
        });
        
        return {
          templateSid: similarTemplate.template_sid,
          templateName: similarTemplate.template_name,
          templatedBody: (similarTemplate.templated_body as string | undefined) ?? undefined,
          placeholderMap,
        };
      }
      
      console.log(`🆕 [WhatsAppTemplateService] No se encontró template similar, se creará uno nuevo`);
      return {};
      
    } catch (error) {
      console.error(`❌ [WhatsAppTemplateService] Error buscando template existente:`, error);
      return {};
    }
  }
  
  /**
   * Prepara el contenido de un mensaje para ser usado como template
   */
  private static prepareTemplateContent(message: string): string {
    // Para templates de WhatsApp, necesitamos un formato específico
    // Simplificamos manteniendo el mensaje original pero asegurándonos de que cumple con los requisitos
    
    // Limitar longitud (WhatsApp templates tienen límites)
    let templateContent = message.length > 1000 ? message.substring(0, 1000) + '...' : message;
    
    // Preservar Unicode y URLs; eliminar solo control/zero-width y normalizar espacios
    templateContent = templateContent
      .normalize('NFC')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    
    // Si el mensaje es muy corto, agregar contexto
    if (templateContent.length < 10) {
      templateContent = `Mensaje automático: ${templateContent}`;
    }
    
    return templateContent;
  }
  
  /**
   * Calcula la similitud entre dos mensajes (simplificado)
   */
  private static calculateSimilarity(str1: string, str2: string): number {
    if (!str1 || !str2) return 0;
    
    // Algoritmo simple de similitud basado en palabras comunes
    const words1 = str1.toLowerCase().split(/\s+/);
    const words2 = str2.toLowerCase().split(/\s+/);
    
    const commonWords = words1.filter(word => words2.includes(word));
    const totalWords = Math.max(words1.length, words2.length);
    
    return totalWords > 0 ? commonWords.length / totalWords : 0;
  }
  
  /**
   * Guarda la referencia del template en nuestra base de datos
   */
  private static async saveTemplateReference(templateData: {
    templateSid: string;
    templateName: string;
    content: string;
    originalMessage: string;
    siteId: string;
    accountSid: string;
    templatedBody?: string;
    placeholderMap?: string[];
  }): Promise<void> {
    try {
      const { error } = await supabaseAdmin
        .from('whatsapp_templates')
        .insert([{
          template_sid: templateData.templateSid,
          template_name: templateData.templateName,
          content: templateData.content,
          original_message: templateData.originalMessage,
          site_id: templateData.siteId,
          account_sid: templateData.accountSid,
          created_at: new Date().toISOString(),
          status: 'active',
          templated_body: templateData.templatedBody ?? null,
          placeholder_map: templateData.placeholderMap ?? null,
        }]);
      
      if (error) {
        console.warn(`⚠️ [WhatsAppTemplateService] No se pudo guardar referencia del template:`, error);
      } else {
        console.log(`💾 [WhatsAppTemplateService] Referencia del template guardada exitosamente`);
      }
    } catch (error) {
      console.warn(`⚠️ [WhatsAppTemplateService] Error guardando referencia del template:`, error);
    }
  }

  /**
   * Incrementa el contador de uso de un template
   */
  private static async incrementTemplateUsage(templateSid: string): Promise<void> {
    try {
      // Obtener el valor actual
      const { data: currentTemplate, error: selectError } = await supabaseAdmin
        .from('whatsapp_templates')
        .select('usage_count')
        .eq('template_sid', templateSid)
        .single();

      if (selectError) {
        console.warn('⚠️ [WhatsAppTemplateService] Error obteniendo template para incremento:', selectError);
        return;
      }

      // Incrementar y actualizar
      const currentCount = currentTemplate?.usage_count || 0;
      const { error } = await supabaseAdmin
        .from('whatsapp_templates')
        .update({ 
          usage_count: currentCount + 1,
          last_used: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('template_sid', templateSid);
      
      if (error) {
        console.warn(`⚠️ [WhatsAppTemplateService] Error incrementando uso del template ${templateSid}:`, error);
      } else {
        console.log(`📊 [WhatsAppTemplateService] Uso del template ${templateSid} incrementado`);
      }
    } catch (error) {
      console.warn(`⚠️ [WhatsAppTemplateService] Error ejecutando función de incremento:`, error);
    }
  }

  /**
   * Obtiene el Messaging Service SID para WhatsApp Content Templates
   */
  private static async getMessagingServiceSid(accountSid: string): Promise<string | null> {
    try {
      console.log(`🔍 [WhatsAppTemplateService] Buscando Messaging Service para account: ${accountSid}`);
      
      // Ya no usar env aquí. Este método queda como fallback neutral (null)
      return null;
      
    } catch (error) {
      console.warn(`⚠️ [WhatsAppTemplateService] Error obteniendo Messaging Service:`, error);
      return null;
    }
  }

  /**
   * Somete un Content Template para aprobación de WhatsApp
   */
  private static async submitTemplateForWhatsAppApproval(
    templateSid: string,
    templateName: string,
    accountSid: string,
    authToken: string
  ): Promise<{ success: boolean; status?: string; error?: string }> {
    try {
      console.log(`📋 [WhatsAppTemplateService] Sometiendo template ${templateSid} para aprobación de WhatsApp`);
      
      // URL de la API de Content Template Approval
      const apiUrl = `https://content.twilio.com/v1/Content/${templateSid}/ApprovalRequests/whatsapp`;
      
      // Crear las credenciales de autenticación básica
      const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
      
      // Preparar el cuerpo de la solicitud
      const approvalBody = {
        name: templateName.toLowerCase(), // WhatsApp requiere lowercase
        category: 'UTILITY' // Categoría por defecto para mensajes automáticos
      };
      
      console.log('🔐 [WhatsAppTemplateService] Datos de aprobación:', {
        url: apiUrl,
        templateSid,
        templateName: approvalBody.name,
        category: approvalBody.category
      });
      
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(approvalBody)
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        console.error(`❌ [WhatsAppTemplateService] Error sometiendo para aprobación:`, errorData);
        return {
          success: false,
          error: `Approval submission failed: ${errorData.message || response.statusText}`
        };
      }
      
      const approvalData = await response.json();
      
      console.log(`✅ [WhatsAppTemplateService] Template sometido para aprobación:`, {
        name: approvalData.name,
        category: approvalData.category,
        status: approvalData.status
      });
      
      return {
        success: true,
        status: approvalData.status
      };
      
    } catch (error) {
      console.error(`❌ [WhatsAppTemplateService] Error en sometimiento para aprobación:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error submitting for approval'
      };
    }
  }

  /**
   * Verifica el estado de aprobación de un Content Template para WhatsApp
   */
  private static async checkTemplateApprovalStatus(
    templateSid: string,
    accountSid: string,
    authToken: string
  ): Promise<{ approved: boolean; status?: string; error?: string }> {
    try {
      console.log(`🔍 [WhatsAppTemplateService] Verificando estado de aprobación: ${templateSid}`);
      
      // URL de la API para verificar estado de aprobación
      const apiUrl = `https://content.twilio.com/v1/Content/${templateSid}/ApprovalRequests`;
      
      // Crear las credenciales de autenticación básica
      const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
      
      const response = await fetch(apiUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/json',
        }
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        console.warn(`⚠️ [WhatsAppTemplateService] Error verificando aprobación:`, errorData);
        return { approved: false, error: errorData.message };
      }
      
      const approvalData = await response.json();
      
      const whatsappApproval = approvalData.whatsapp;
      const isApproved = whatsappApproval && whatsappApproval.status === 'approved';
      
      console.log(`📊 [WhatsAppTemplateService] Estado de aprobación:`, {
        templateSid,
        status: whatsappApproval?.status,
        approved: isApproved
      });
      
      return {
        approved: isApproved,
        status: whatsappApproval?.status
      };
      
    } catch (error) {
      console.warn(`⚠️ [WhatsAppTemplateService] Error verificando aprobación:`, error);
      return { approved: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Obtiene información detallada sobre códigos de error de Twilio/WhatsApp
   */
  public static getTwilioErrorInfo(errorCode: number): { 
    description: string; 
    type: string; 
    suggestion: string;
    whatsappCode?: string; 
  } {
    const errorMap: Record<number, { description: string; type: string; suggestion: string; whatsappCode?: string }> = {
      // Errores de ventana de respuesta
      63016: {
        description: "Fuera de ventana de respuesta (24h) - Requiere template aprobado",
        type: "RESPONSE_WINDOW",
        suggestion: "Usar Content Template aprobado o esperar a que el usuario responda",
        whatsappCode: "470"
      },
      
      // Errores específicos del usuario/destinatario
      63032: {
        description: "Limitación de WhatsApp para este usuario específico",
        type: "USER_LIMITATION", 
        suggestion: "Usuario puede haber bloqueado, reportado spam, o hay frequency capping. Verificar con otro número",
        whatsappCode: "472"
      },
      
      63003: {
        description: "Número de destinatario inválido o no registrado en WhatsApp",
        type: "INVALID_NUMBER",
        suggestion: "Verificar que el número esté en formato internacional correcto y tenga WhatsApp",
        whatsappCode: "1006"
      },
      
      // Errores de configuración
      63007: {
        description: "Número remitente no encontrado o no configurado para WhatsApp",
        type: "SENDER_CONFIG", 
        suggestion: "Verificar configuración del número de WhatsApp Business en Twilio",
        whatsappCode: "N/A"
      },
      
      63020: {
        description: "Invitación de Twilio no aceptada en Meta Business Manager",
        type: "BUSINESS_SETUP",
        suggestion: "Aceptar invitación en Meta Business Manager para enviar mensajes",
        whatsappCode: "402"
      },
      
      // Errores de límites y calidad
      63018: {
        description: "Límite de velocidad de mensajes excedido",
        type: "RATE_LIMIT",
        suggestion: "Reducir frecuencia de envío o solicitar aumento de límites",
        whatsappCode: "429"
      },
      
      63022: {
        description: "Limitaciones de calidad o spam detectado",
        type: "QUALITY_LIMIT",
        suggestion: "Revisar calidad de mensajes y evitar contenido que pueda parecer spam",
        whatsappCode: "430"
      },
      
      // Errores de template
      63024: {
        description: "Problema con el template de mensaje",
        type: "TEMPLATE_ERROR",
        suggestion: "Verificar que el template esté aprobado y correctamente configurado",
        whatsappCode: "1002"
      },
      
      // Errores de cuenta/pago
      63021: {
        description: "Problema con la cuenta de WhatsApp Business",
        type: "ACCOUNT_ERROR", 
        suggestion: "Verificar estado de la cuenta y métodos de pago en Meta Business Manager",
        whatsappCode: "1001"
      }
    };
    
    const errorInfo = errorMap[errorCode];
    
    if (errorInfo) {
      return errorInfo;
    }
    
    // Error desconocido
    return {
      description: `Error desconocido de Twilio (${errorCode})`,
      type: "UNKNOWN",
      suggestion: "Revisar documentación de Twilio o contactar soporte",
      whatsappCode: "unknown"
    };
  }
} 