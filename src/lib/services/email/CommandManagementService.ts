/**
 * CommandManagementService - Servicio para manejo de comandos de email
 * Maneja creación, ejecución y espera de comandos
 */

import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { EmailTextExtractorService } from './EmailTextExtractorService';
import { supabaseAdmin } from '@/lib/database/supabase-client';

export class CommandManagementService {
  private static processorInitializer = ProcessorInitializer.getInstance();
  private static commandService: any;

  static {
    this.processorInitializer.initialize();
    this.commandService = this.processorInitializer.getCommandService();
  }

  /**
   * Función para validar UUIDs
   */
  private static isValidUUID(uuid: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
  }

  /**
   * Obtiene el UUID de la base de datos para un comando
   */
  static async getCommandDbUuid(internalId: string): Promise<string | null> {
    try {
      const command = await this.commandService.getCommandById(internalId);
      
      // Verificar metadata
      if (command && command.metadata && command.metadata.dbUuid) {
        if (this.isValidUUID(command.metadata.dbUuid)) {
          console.log(`🔑 UUID encontrado en metadata: ${command.metadata.dbUuid}`);
          return command.metadata.dbUuid;
        }
      }
      
      // Buscar en el mapa de traducción interno
      try {
        // @ts-ignore - Accediendo a propiedades internas
        const idMap = (this.commandService as any).idTranslationMap;
        if (idMap && idMap.get && idMap.get(internalId)) {
          const mappedId = idMap.get(internalId);
          if (this.isValidUUID(mappedId)) {
            console.log(`🔑 UUID encontrado en mapa interno: ${mappedId}`);
            return mappedId;
          }
        }
      } catch (err) {
        console.log('No se pudo acceder al mapa de traducción interno');
      }
      
      // Buscar en la base de datos directamente
      if (command) {
        const { data, error } = await supabaseAdmin
          .from('commands')
          .select('id')
          .eq('task', command.task)
          .eq('user_id', command.user_id)
          .eq('status', command.status)
          .order('created_at', { ascending: false })
          .limit(1);
        
        if (!error && data && data.length > 0) {
          console.log(`🔑 UUID encontrado en búsqueda directa: ${data[0].id}`);
          return data[0].id;
        }
      }
      
      return null;
    } catch (error) {
      console.error('Error al obtener UUID de base de datos:', error);
      return null;
    }
  }

  /**
   * Espera a que un comando se complete
   */
  static async waitForCommandCompletion(
    commandId: string, 
    maxAttempts = 200, 
    delayMs = 1000
  ): Promise<{command: any, dbUuid: string | null, completed: boolean}> {
    let executedCommand = null;
    let attempts = 0;
    let dbUuid: string | null = null;
    
    console.log(`⏳ Esperando a que se complete el comando ${commandId}...`);
    
    return new Promise<{command: any, dbUuid: string | null, completed: boolean}>((resolve) => {
      const checkInterval = setInterval(async () => {
        attempts++;
        
        try {
          executedCommand = await this.commandService.getCommandById(commandId);
          
          if (!executedCommand) {
            console.log(`⚠️ No se pudo encontrar el comando ${commandId}`);
            clearInterval(checkInterval);
            resolve({command: null, dbUuid: null, completed: false});
            return;
          }
          
          // Guardar el UUID de la base de datos si está disponible
          if (executedCommand.metadata && executedCommand.metadata.dbUuid) {
            dbUuid = executedCommand.metadata.dbUuid as string;
            console.log(`🔑 UUID de base de datos encontrado en metadata: ${dbUuid}`);
          }
          
          // Considerar comandos en estado 'failed' como completados si tienen resultados
          const hasResults = executedCommand.results && executedCommand.results.length > 0;
          const commandFinished = executedCommand.status === 'completed' || 
                                 (executedCommand.status === 'failed' && hasResults);
                                 
          if (commandFinished) {
            console.log(`✅ Comando ${commandId} terminado con estado: ${executedCommand.status}${hasResults ? ' (con resultados)' : ''}`);
            
            // Intentar obtener el UUID de la base de datos si aún no lo tenemos
            if (!dbUuid || !this.isValidUUID(dbUuid)) {
              dbUuid = await this.getCommandDbUuid(commandId);
              console.log(`🔍 UUID obtenido después de completar: ${dbUuid || 'No encontrado'}`);
            }
            
            clearInterval(checkInterval);
            const effectivelyCompleted = executedCommand.status === 'completed' || 
                                       (executedCommand.status === 'failed' && hasResults);
            resolve({command: executedCommand, dbUuid, completed: effectivelyCompleted});
            return;
          }
          
          console.log(`⏳ Comando ${commandId} aún en ejecución (estado: ${executedCommand.status}), intento ${attempts}/${maxAttempts}`);
          
          if (attempts >= maxAttempts) {
            console.log(`⏰ Tiempo de espera agotado para el comando ${commandId}`);
            
            // Último intento de obtener el UUID
            if (!dbUuid || !this.isValidUUID(dbUuid)) {
              dbUuid = await this.getCommandDbUuid(commandId);
              console.log(`🔍 UUID obtenido antes de timeout: ${dbUuid || 'No encontrado'}`);
            }
            
            clearInterval(checkInterval);
            const usableResults = executedCommand.results && executedCommand.results.length > 0;
            resolve({command: executedCommand, dbUuid, completed: usableResults});
          }
        } catch (error) {
          console.error(`Error al verificar estado del comando ${commandId}:`, error);
          clearInterval(checkInterval);
          resolve({command: null, dbUuid: null, completed: false});
        }
      }, delayMs);
    });
  }

  /**
   * Crea un comando de email optimizado
   */
  static createEmailCommand(
    agentId: string, 
    siteId: string, 
    emails: any[], 
    emailConfig: any, 
    analysisType?: string, 
    leadId?: string, 
    teamMemberId?: string, 
    userId?: string
  ) {
    console.log(`[COMMAND_MGMT] 🔍 Iniciando createEmailCommand`);
    const defaultUserId = '00000000-0000-0000-0000-000000000000';

    // Optimizar emails extrayendo solo el texto relevante
    console.log(`[COMMAND_MGMT] 🔧 Optimizando ${emails.length} emails antes del análisis...`);
    const optimizedEmails = EmailTextExtractorService.extractMultipleEmailsText(emails, {
      maxTextLength: 1000,
      removeSignatures: true,
      removeQuotedText: true,
      removeHeaders: true,
      removeLegalDisclaimer: true
    });

    // Calcular estadísticas de optimización
    const totalOriginalLength = optimizedEmails.reduce((sum, email) => sum + email.originalLength, 0);
    const totalOptimizedLength = optimizedEmails.reduce((sum, email) => sum + email.textLength, 0);
    const compressionRatio = totalOriginalLength > 0 ? (totalOptimizedLength / totalOriginalLength) : 0;
    
    console.log(`[COMMAND_MGMT] 📊 Optimización completada:`);
    console.log(`[COMMAND_MGMT] - Texto original: ${totalOriginalLength} caracteres`);
    console.log(`[COMMAND_MGMT] - Texto optimizado: ${totalOptimizedLength} caracteres`);
    console.log(`[COMMAND_MGMT] - Ratio de compresión: ${(compressionRatio * 100).toFixed(1)}%`);

    // Crear versión ultra-optimizada con solo los datos esenciales
    const essentialEmailData = optimizedEmails.map((email, index) => ({
      id: emails[index]?.id || emails[index]?.messageId || emails[index]?.uid || `temp_${Date.now()}_${index}`,
      subject: email.subject,
      from: email.from,
      to: email.to,
      content: email.extractedText,
      date: emails[index]?.date || emails[index]?.received_date || 'unknown'
    }));

    const finalDataSize = JSON.stringify(essentialEmailData).length;
    const originalDataSize = JSON.stringify(optimizedEmails).length;
    
    console.log(`[COMMAND_MGMT] 🚀 Optimización final completada:`);
    console.log(`[COMMAND_MGMT] - Datos esenciales finales: ${finalDataSize} caracteres`);
    console.log(`[COMMAND_MGMT] - Ahorro total vs original: ~${Math.round((totalOriginalLength - finalDataSize) / 4)} tokens`);

    const createdCommand = CommandFactory.createCommand({
      task: 'reply to emails',
      userId: userId || teamMemberId || defaultUserId,
      agentId: agentId,
      site_id: siteId,
      description: 'Identify potential leads, commercial opportunities and clients inqueries to reply. Focus ONLY on emails from prospects showing genuine interest in our products/services. IGNORE: transactional emails, vendor outreach, spam, and cold sales pitches from other companies unless they demonstrate clear interest in becoming customers.',
      targets: [
        {
          email: {
            id: "email_id_from_context",
            original_subject: "Original subject of the email",
            original_text: "Original email content/message as received",
            summary: "Summary of the message and client inquiry",
            contact_info: {
              name: "name found in the email",
              email: "from email address",
              phone: "phone found in the email",
              company: "company found in the email"
            }
          }
        }
      ],
      tools: [],
      context: JSON.stringify({
        emails: essentialEmailData,
        email_count: emails.length,
        optimized_email_count: essentialEmailData.length,
        text_compression_stats: {
          original_chars: totalOriginalLength,
          final_chars: finalDataSize,
          compression_ratio: (finalDataSize / totalOriginalLength * 100).toFixed(1) + '%',
          tokens_saved: Math.round((totalOriginalLength - finalDataSize) / 4)
        },
        site_id: siteId,
        inbox_info: {
          email_address: emailConfig?.email_address || 'unknown',
          provider: emailConfig?.provider || 'unknown',
          display_name: emailConfig?.display_name || emailConfig?.email_address || 'Unknown Inbox',
          company_name: emailConfig?.company_name || 'Unknown Company',
          business_type: emailConfig?.business_type || 'Unknown Business Type',
          industry: emailConfig?.industry || 'Unknown Industry'
        },
        analysis_type: analysisType,
        lead_id: leadId,
        team_member_id: teamMemberId,
        special_instructions: 'Return an array with every important email. Analyze only the essential email data provided. Email content has been heavily optimized: signatures, quoted text, headers, and legal disclaimers removed. Text limited to 1000 chars per email. Focus on emails showing genuine commercial interest. IMPORTANT: If there is not at least 1 email that require a response or qualify as a potential lead, RETURN AN EMPTY ARRAY in the results. []. CRITICAL: Always include the "id" field from the email context in your response for each email you analyze. IMPORTANT: Also include the "original_text" field with the actual email content from the context for each email you process.'
      }),
      supervisor: [
        { agent_role: "email_specialist", status: "not_initialized" },
        { agent_role: "sales_manager", status: "not_initialized" },
        { agent_role: "customer_service_manager", status: "not_initialized" }
      ],
      model: "gpt-5",
      modelType: "openai"
    });
    
    console.log(`[COMMAND_MGMT] ✅ CommandFactory.createCommand completado`);
    return createdCommand;
  }

  /**
   * Envía un comando al servicio
   */
  static async submitCommand(command: any): Promise<string> {
    console.log(`[COMMAND_MGMT] 📤 Enviando comando al servicio...`);
    const internalCommandId = await this.commandService.submitCommand(command);
    console.log(`[COMMAND_MGMT] ✅ Comando enviado con ID: ${internalCommandId}`);
    return internalCommandId;
  }
}