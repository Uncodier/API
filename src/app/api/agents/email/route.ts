/**
 * API de Email - Encargada de obtener y analizar emails
 * Route: POST /api/agents/email
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { EmailService } from '@/lib/services/email/EmailService';
import { EmailConfigService } from '@/lib/services/email/EmailConfigService';
import { EmailTextExtractorService } from '@/lib/services/email/EmailTextExtractorService';
import { EmailFilterService } from '@/lib/services/email/EmailFilterService';
import { SyncedObjectsService } from '@/lib/services/synced-objects/SyncedObjectsService';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { CaseConverterService, getFlexibleProperty } from '@/lib/utils/case-converter';

// Configuración de timeout extendido para Vercel
export const maxDuration = 300; // 5 minutos en segundos (máximo para plan Pro)

// Initialize processor and get command service
const processorInitializer = ProcessorInitializer.getInstance();
processorInitializer.initialize();
const commandService = processorInitializer.getCommandService();

// Create schemas for request validation
const EmailAgentRequestSchema = z.object({
  site_id: z.string().min(1, "Site ID is required"),
  limit: z.number().default(10).optional(),
  lead_id: z.string().optional(),
  agentId: z.string().optional(),
  user_id: z.string().optional(),
  team_member_id: z.string().optional(),
  analysis_type: z.string().optional(),
  since_date: z.string().optional().refine(
    (date) => !date || !isNaN(Date.parse(date)),
    "since_date debe ser una fecha válida en formato ISO"
  ),
});

// Error codes
const ERROR_CODES = {
  INVALID_REQUEST: 'INVALID_REQUEST',
  EMAIL_CONFIG_NOT_FOUND: 'EMAIL_CONFIG_NOT_FOUND',
  EMAIL_FETCH_ERROR: 'EMAIL_FETCH_ERROR',
  SYSTEM_ERROR: 'SYSTEM_ERROR',
  AGENT_NOT_FOUND: 'AGENT_NOT_FOUND'
};

// Función para validar UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

/**
 * Obtiene la URL del servidor para filtrar feedback loops
 */
function getServerUrl(): string {
  const serverUrl = process.env.NEXT_PUBLIC_ORIGIN || 
                   process.env.VERCEL_URL || 
                   process.env.NEXT_PUBLIC_APP_URL || 
                   'http://localhost:3000';
  
  // Asegurarse de que la URL tenga protocolo
  if (!serverUrl.startsWith('http')) {
    return `https://${serverUrl}`;
  }
  
  return serverUrl;
}

/**
 * Extrae el dominio de una URL
 */
function extractDomainFromUrl(url: string): string | null {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Obtiene las direcciones de email no-reply configuradas
 */
function getNoReplyAddresses(): string[] {
  const addresses = [
    process.env.EMAIL_FROM,
    process.env.SENDGRID_FROM_EMAIL,
    process.env.NO_REPLY_EMAILS, // Nueva variable para configurar emails adicionales
    'no-reply@uncodie.com',
    'noreply@uncodie.com',
    'no-reply@example.com',
    'noreply@example.com'
  ].filter(Boolean); // Remover valores undefined/null
  
  // Si NO_REPLY_EMAILS es una lista separada por comas, dividirla
  const expandedAddresses: string[] = [];
  addresses.forEach(addr => {
    if (addr && typeof addr === 'string') {
      if (addr.includes(',')) {
        expandedAddresses.push(...addr.split(',').map(a => a.trim()));
      } else {
        expandedAddresses.push(addr);
      }
    }
  });
  
  // Remover duplicados usando Array.from para compatibilidad
  return Array.from(new Set(expandedAddresses));
}



/**
 * Filtra emails que contengan referencias al servidor o direcciones no-reply para evitar feedback loops
 */
function filterFeedbackLoopEmails(emails: any[]): any[] {
  if (emails.length === 0) {
    return emails;
  }

  const serverUrl = getServerUrl();
  const serverDomain = extractDomainFromUrl(serverUrl);
  const noReplyAddresses = getNoReplyAddresses();
  
  console.log(`[EMAIL_API] 🔄 Filtrando emails para evitar feedback loops:`);
  console.log(`[EMAIL_API] - Dominio del servidor: ${serverDomain || 'No detectado'}`);
  console.log(`[EMAIL_API] - Direcciones no-reply bloqueadas: ${noReplyAddresses.join(', ')}`);
  
  const filteredEmails = emails.filter(email => {
    const emailContent = (email.body || email.text || '').toLowerCase();
    const emailSubject = (email.subject || '').toLowerCase();
    const emailFrom = (email.from || '').toLowerCase();
    
    // 1. Verificar si el email contiene la URL del servidor
    const containsServerUrl = serverDomain && (
      emailContent.includes(serverDomain) || 
      emailSubject.includes(serverDomain) ||
      emailContent.includes(serverUrl.toLowerCase())
    );
    
    // 2. Verificar si el email viene de una dirección relacionada con nuestro servidor
    const isFromServerDomain = serverDomain && emailFrom.includes(serverDomain);
    
    // 3. Verificar si el email viene de una dirección no-reply configurada
    const isFromNoReplyAddress = noReplyAddresses.some(noReplyAddr => {
      if (!noReplyAddr) return false;
      const normalizedAddr = noReplyAddr.toLowerCase();
      
      // Verificar coincidencia exacta
      if (emailFrom.includes(normalizedAddr)) {
        console.log(`[EMAIL_API] 🚫 Email de dirección no-reply detectado: ${emailFrom} contiene ${normalizedAddr}`);
        return true;
      }
      
      // Verificar si el dominio de la dirección no-reply coincide
      const noReplyDomain = extractDomainFromUrl(`mailto:${normalizedAddr}`);
      if (noReplyDomain && emailFrom.includes(noReplyDomain)) {
        console.log(`[EMAIL_API] 🚫 Email de dominio no-reply detectado: ${emailFrom} contiene dominio ${noReplyDomain}`);
        return true;
      }
      
      return false;
    });
    
    // 4. Verificar patrones comunes de emails automáticos
    const isAutomatedEmail = (
      emailFrom.includes('noreply') || 
      emailFrom.includes('no-reply') ||
      emailFrom.includes('donotreply') ||
      emailFrom.includes('do-not-reply') ||
      emailFrom.includes('automated') ||
      emailFrom.includes('system@') ||
      emailFrom.includes('daemon@') ||
      (emailSubject.includes('re:') && 
        (emailContent.includes('generated by') || 
         emailContent.includes('automated') ||
         emailContent.includes('do not reply') ||
         emailContent.includes('noreply')))
    );
    
    // 5. Verificar headers específicos de emails automáticos
    const hasAutomatedHeaders = email.headers && (
      email.headers['auto-submitted'] ||
      email.headers['x-auto-response-suppress'] ||
      (email.headers['precedence'] && email.headers['precedence'].toLowerCase() === 'bulk')
    );
    
    const shouldExclude = containsServerUrl || isFromServerDomain || isFromNoReplyAddress || isAutomatedEmail || hasAutomatedHeaders;
    
    if (shouldExclude) {
      console.log(`[EMAIL_API] 🚫 Email excluido (feedback loop): From: ${email.from}, Subject: ${email.subject}`);
      console.log(`[EMAIL_API] 🔍 Razones de exclusión:`, {
        containsServerUrl,
        isFromServerDomain,
        isFromNoReplyAddress,
        isAutomatedEmail,
        hasAutomatedHeaders
      });
      return false;
    }
    
    return true;
  });

  console.log(`[EMAIL_API] 🔄 Filtrado de feedback loops completado: ${filteredEmails.length}/${emails.length} emails incluidos`);
  return filteredEmails;
}

/**
 * Busca leads asignados a la IA (assignee_id IS NULL) por email
 */
async function findLeadsAssignedToAI(emails: any[], siteId: string): Promise<Map<string, any>> {
  try {
    console.log(`[EMAIL_API] 🤖 Buscando leads asignados a la IA para ${emails.length} emails en sitio: ${siteId}`);
    
    // Extraer emails únicos de los correos
    const emailAddresses = emails.map(email => {
      const fromEmail = (email.from || '').toLowerCase().trim();
      // Extraer email de formato "Name <email@domain.com>"
      const emailMatch = fromEmail.match(/<([^>]+)>/);
      return emailMatch ? emailMatch[1] : fromEmail;
    }).filter(email => email && email.includes('@'));
    
    if (emailAddresses.length === 0) {
      console.log(`[EMAIL_API] ⚠️ No se encontraron direcciones de email válidas para buscar leads`);
      return new Map();
    }
    
    console.log(`[EMAIL_API] 📧 Buscando leads para ${emailAddresses.length} direcciones de email únicas`);
    
    // Buscar leads asignados a la IA (assignee_id IS NULL) que coincidan con los emails
    const { data: aiLeads, error } = await supabaseAdmin
      .from('leads')
      .select('id, email, name, assignee_id, status, created_at')
      .eq('site_id', siteId)
      .is('assignee_id', null) // Asignados a la IA
      .in('email', emailAddresses);
    
    if (error) {
      console.error(`[EMAIL_API] ❌ Error buscando leads asignados a la IA:`, error);
      return new Map();
    }
    
    const leadsMap = new Map<string, any>();
    
    if (aiLeads && aiLeads.length > 0) {
      console.log(`[EMAIL_API] 🎯 Encontrados ${aiLeads.length} leads asignados a la IA:`);
      
      aiLeads.forEach(lead => {
        leadsMap.set(lead.email.toLowerCase(), lead);
        console.log(`[EMAIL_API] - Lead ${lead.name} (${lead.email}) - Estado: ${lead.status} - ID: ${lead.id}`);
      });
    } else {
      console.log(`[EMAIL_API] ℹ️ No se encontraron leads asignados a la IA para los emails proporcionados`);
    }
    
    return leadsMap;
  } catch (error) {
    console.error(`[EMAIL_API] 💥 Error buscando leads asignados a la IA:`, error);
    return new Map();
  }
}

/**
 * Función para filtrar emails según aliases configurados y leads asignados a la IA
 */
function filterEmailsByAliasesAndAILeads(emails: any[], aliases: string[], aiLeadsMap: Map<string, any>): any[] {
  // Validar que aliases sea un array válido
  const hasValidAliases = Array.isArray(aliases) && aliases.length > 0;
  const validAliases = hasValidAliases ? aliases.filter(alias => typeof alias === 'string' && alias.trim().length > 0) : [];
  
  console.log(`[EMAIL_API] 🔍 Filtrando ${emails.length} emails:`);
  console.log(`[EMAIL_API] - Aliases configurados: ${validAliases.length > 0 ? validAliases.join(', ') : 'Ninguno'}`);
  console.log(`[EMAIL_API] - Leads asignados a IA encontrados: ${aiLeadsMap.size}`);
  
  const filteredEmails = emails.filter(email => {
    const emailTo = (email.to || '').toLowerCase().trim();
    const emailFrom = (email.from || '').toLowerCase().trim();
    
    // Extraer email del remitente para verificar si es un lead asignado a la IA
    const fromEmailAddress = emailFrom.match(/<([^>]+)>/) ? emailFrom.match(/<([^>]+)>/)?.[1] : emailFrom;
    
    console.log(`[EMAIL_API] 🔍 Verificando email - From: ${email.from}, To: ${email.to}`);
    
    // NUEVA VALIDACIÓN: Excluir emails "self-sent" donde FROM == TO
    // Estos son típicamente emails enviados desde el alias hacia sí mismo, no emails recibidos
    const fromEmailOnly = fromEmailAddress || emailFrom;
    const toEmailOnly = emailTo.match(/<([^>]+)>/) ? emailTo.match(/<([^>]+)>/)?.[1] : emailTo;
    
    if (fromEmailOnly && toEmailOnly && fromEmailOnly === toEmailOnly) {
      console.log(`[EMAIL_API] 🚫 Email excluido - Self-sent email detectado: FROM (${fromEmailOnly}) == TO (${toEmailOnly})`);
      console.log(`[EMAIL_API] 🔍 Razón: Los emails donde FROM == TO típicamente son emails enviados desde el alias, no recibidos hacia el alias`);
      return false;
    }
    
    // 1. Verificar si el remitente es un lead asignado a la IA
    if (fromEmailAddress && aiLeadsMap.has(fromEmailAddress)) {
      const aiLead = aiLeadsMap.get(fromEmailAddress);
      console.log(`[EMAIL_API] 🤖 Email de lead asignado a IA detectado: ${aiLead.name} (${aiLead.email}) - INCLUIDO automáticamente`);
      return true;
    }
    
    // 2. Si no hay aliases válidos configurados, incluir todos los emails (excepto los ya filtrados por feedback loops)
    if (validAliases.length === 0) {
      console.log(`[EMAIL_API] ✅ Email incluido - No hay aliases configurados (procesar todos)`);
      return true;
    }
    
    // 3. Verificar contra aliases configurados (lógica original)
    const destinationFields = [
      emailTo,
      email.headers?.['delivered-to']?.toLowerCase?.().trim?.() || '',
      email.headers?.['x-original-to']?.toLowerCase?.().trim?.() || '',
      email.headers?.['x-envelope-to']?.toLowerCase?.().trim?.() || '',
      email.headers?.['x-rcpt-to']?.toLowerCase?.().trim?.() || '',
      email.headers?.['envelope-to']?.toLowerCase?.().trim?.() || '',
      email.headers?.['x-received-for']?.toLowerCase?.().trim?.() || '',
      email.headers?.['x-received']?.toLowerCase?.().trim?.() || ''
    ].filter(field => field && field.length > 0);

    console.log(`[EMAIL_API] 🔍 Headers relevantes encontrados:`, {
      'delivered-to': email.headers?.['delivered-to'],
      'x-original-to': email.headers?.['x-original-to'], 
      'x-envelope-to': email.headers?.['x-envelope-to'],
      'x-rcpt-to': email.headers?.['x-rcpt-to'],
      'envelope-to': email.headers?.['envelope-to']
    });
    
    // Verificar si algún alias coincide con alguno de los campos de destinatario
    const isValidByAlias = validAliases.some(alias => {
      const normalizedAlias = alias.toLowerCase().trim();
      
      return destinationFields.some(destinationField => {
        // Verificar coincidencia exacta
        if (destinationField === normalizedAlias) {
          console.log(`[EMAIL_API] ✅ Coincidencia exacta por alias: ${destinationField} = ${normalizedAlias}`);
          return true;
        }
        
        // Verificar si el alias está incluido en el campo
        if (destinationField.includes(normalizedAlias)) {
          console.log(`[EMAIL_API] ✅ Coincidencia parcial por alias: ${destinationField} contiene ${normalizedAlias}`);
          return true;
        }
        
        // Verificar coincidencia en formato "Name <email@domain.com>" o similar
        const emailMatches = destinationField.match(/<([^>]+)>/g);
        if (emailMatches) {
          const foundMatch = emailMatches.some((match: string) => {
            const extractedEmail = match.replace(/[<>]/g, '').trim();
            return extractedEmail === normalizedAlias;
          });
          if (foundMatch) {
            console.log(`[EMAIL_API] ✅ Coincidencia en formato <email> por alias: ${destinationField}`);
            return true;
          }
        }
        
        // Verificar si hay múltiples emails separados por coma
        if (destinationField.includes(',')) {
          const emailList = destinationField.split(',').map((e: string) => e.trim());
          const foundInList = emailList.some((singleEmail: string) => {
            const cleanEmail = singleEmail.replace(/.*<([^>]+)>.*/, '$1').trim();
            return cleanEmail === normalizedAlias || singleEmail === normalizedAlias;
          });
          if (foundInList) {
            console.log(`[EMAIL_API] ✅ Coincidencia en lista de emails por alias: ${destinationField}`);
            return true;
          }
        }
        
        return false;
      });
    });

    if (isValidByAlias) {
      console.log(`[EMAIL_API] ✅ Email incluido por alias - To: ${email.to}`);
    } else {
      console.log(`[EMAIL_API] ❌ Email excluido - No coincide con aliases ni es lead asignado a IA`);
      console.log(`[EMAIL_API] ❌ From: ${email.from}, To: ${email.to}`);
      console.log(`[EMAIL_API] ❌ Aliases verificados: ${validAliases.join(', ')}`);
      console.log(`[EMAIL_API] ❌ Campos verificados: ${destinationFields.join(', ')}`);
    }

    return isValidByAlias;
  });

  console.log(`[EMAIL_API] 📊 Filtrado completado: ${filteredEmails.length}/${emails.length} emails incluidos`);
  console.log(`[EMAIL_API] - Por aliases: ${filteredEmails.length - aiLeadsMap.size} emails`);
  console.log(`[EMAIL_API] - Por leads asignados a IA: ${Math.min(aiLeadsMap.size, filteredEmails.length)} emails`);
  
  return filteredEmails;
}

/**
 * Busca el agente de soporte para un sitio
 */
async function findSupportAgent(siteId: string): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from('agents')
    .select('id')
    .eq('site_id', siteId)
    .eq('role', 'Customer Support')
    .single();

  if (error || !data) {
    throw new Error(`No se encontró un agente de soporte para el sitio ${siteId}`);
  }

  return data.id;
}

// Función para obtener el UUID de la base de datos para un comando
async function getCommandDbUuid(internalId: string): Promise<string | null> {
  try {
    // Intentar obtener el comando
    const command = await commandService.getCommandById(internalId);
    
    // Verificar metadata
    if (command && command.metadata && command.metadata.dbUuid) {
      if (isValidUUID(command.metadata.dbUuid)) {
        console.log(`🔑 UUID encontrado en metadata: ${command.metadata.dbUuid}`);
        return command.metadata.dbUuid;
      }
    }
    
    // Buscar en el mapa de traducción interno del CommandService
    try {
      // @ts-ignore - Accediendo a propiedades internas
      const idMap = (commandService as any).idTranslationMap;
      if (idMap && idMap.get && idMap.get(internalId)) {
        const mappedId = idMap.get(internalId);
        if (isValidUUID(mappedId)) {
          console.log(`🔑 UUID encontrado en mapa interno: ${mappedId}`);
          return mappedId;
        }
      }
    } catch (err) {
      console.log('No se pudo acceder al mapa de traducción interno');
    }
    
    // Buscar en la base de datos directamente por algún campo que pueda relacionarse
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

// Función para esperar a que un comando se complete
async function waitForCommandCompletion(commandId: string, maxAttempts = 100, delayMs = 1000) {
  let executedCommand = null;
  let attempts = 0;
  let dbUuid: string | null = null;
  
  console.log(`⏳ Esperando a que se complete el comando ${commandId}...`);
  
  // Crear una promesa que se resuelve cuando el comando se completa o se agota el tiempo
  return new Promise<{command: any, dbUuid: string | null, completed: boolean}>((resolve) => {
    const checkInterval = setInterval(async () => {
      attempts++;
      
      try {
        executedCommand = await commandService.getCommandById(commandId);
        
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
          if (!dbUuid || !isValidUUID(dbUuid)) {
            dbUuid = await getCommandDbUuid(commandId);
            console.log(`🔍 UUID obtenido después de completar: ${dbUuid || 'No encontrado'}`);
          }
          
          clearInterval(checkInterval);
          // Consideramos un comando fallido como "completado" si tiene resultados
          const effectivelyCompleted = executedCommand.status === 'completed' || 
                                     (executedCommand.status === 'failed' && hasResults);
          resolve({command: executedCommand, dbUuid, completed: effectivelyCompleted});
          return;
        }
        
        console.log(`⏳ Comando ${commandId} aún en ejecución (estado: ${executedCommand.status}), intento ${attempts}/${maxAttempts}`);
        
        if (attempts >= maxAttempts) {
          console.log(`⏰ Tiempo de espera agotado para el comando ${commandId}`);
          
          // Último intento de obtener el UUID
          if (!dbUuid || !isValidUUID(dbUuid)) {
            dbUuid = await getCommandDbUuid(commandId);
            console.log(`🔍 UUID obtenido antes de timeout: ${dbUuid || 'No encontrado'}`);
          }
          
          clearInterval(checkInterval);
          // Verificar si, a pesar del timeout, hay resultados utilizables
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

// Create command object for email analysis
function createEmailCommand(agentId: string, siteId: string, emails: any[], emailConfig: any, analysisType?: string, leadId?: string, teamMemberId?: string, userId?: string) {
  const defaultUserId = '00000000-0000-0000-0000-000000000000';

  // Optimizar emails extrayendo solo el texto relevante
  console.log(`[EMAIL_API] 🔧 Optimizando ${emails.length} emails antes del análisis...`);
  const optimizedEmails = EmailTextExtractorService.extractMultipleEmailsText(emails, {
    maxTextLength: 1000, // Reducir aún más el límite de texto por email
    removeSignatures: true,
    removeQuotedText: true,
    removeHeaders: true,
    removeLegalDisclaimer: true
  });

  // Calcular estadísticas de optimización
  const totalOriginalLength = optimizedEmails.reduce((sum, email) => sum + email.originalLength, 0);
  const totalOptimizedLength = optimizedEmails.reduce((sum, email) => sum + email.textLength, 0);
  const compressionRatio = totalOriginalLength > 0 ? (totalOptimizedLength / totalOriginalLength) : 0;
  
  console.log(`[EMAIL_API] 📊 Optimización completada:`);
  console.log(`[EMAIL_API] - Texto original: ${totalOriginalLength} caracteres`);
  console.log(`[EMAIL_API] - Texto optimizado: ${totalOptimizedLength} caracteres`);
  console.log(`[EMAIL_API] - Ratio de compresión: ${(compressionRatio * 100).toFixed(1)}%`);
  console.log(`[EMAIL_API] - Ahorro de tokens: ~${Math.round((totalOriginalLength - totalOptimizedLength) / 4)} tokens`);

  // Crear versión ultra-optimizada con solo los datos esenciales para el contexto
  // IMPORTANTE: Ahora incluimos el ID del email original
  const essentialEmailData = optimizedEmails.map((email, index) => ({
    id: emails[index]?.id || emails[index]?.messageId || emails[index]?.uid || `temp_${Date.now()}_${index}`, // ID del email original
    subject: email.subject,
    from: email.from,
    to: email.to,
    content: email.extractedText, // Solo el texto optimizado, NO el original
    date: emails[index]?.date || emails[index]?.received_date || 'unknown'
  }));

  // Calcular estadísticas finales con los datos esenciales
  const finalDataSize = JSON.stringify(essentialEmailData).length;
  const originalDataSize = JSON.stringify(optimizedEmails).length;
  const finalCompressionRatio = originalDataSize > 0 ? (finalDataSize / originalDataSize) : 0;
  
  console.log(`[EMAIL_API] 🚀 Optimización final completada:`);
  console.log(`[EMAIL_API] - Datos optimizados completos: ${originalDataSize} caracteres`);
  console.log(`[EMAIL_API] - Datos esenciales finales: ${finalDataSize} caracteres`);
  console.log(`[EMAIL_API] - Compresión adicional: ${(finalCompressionRatio * 100).toFixed(1)}%`);
  console.log(`[EMAIL_API] - Ahorro total vs original: ~${Math.round((totalOriginalLength - finalDataSize) / 4)} tokens`);

  return CommandFactory.createCommand({
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
      emails: essentialEmailData, // Ahora incluye IDs de emails
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
      special_instructions: 'Return an array with every important email. Analyze only the essential email data provided. Email content has been heavily optimized: signatures, quoted text, headers, and legal disclaimers removed. Text limited to 1000 chars per email. Focus on emails showing genuine commercial interest. IMPORTANT: If there is not at least 1 email that require a response or qualify as a potential lead, RETURN AN EMPTY ARRAY in the results. []. DO NOT ANALYZE ALL THE EMMAILS IN A SINGLE SUMMARY AS THIS WILL GENERATE A WRONG ANSWER OR REPLY FOR A LEAD OR CLIENT. CRITICAL: Always include the "id" field from the email context in your response for each email you analyze. This ID is essential for tracking and preventing duplicates. IMPORTANT: Also include the "original_text" field with the actual email content from the context for each email you process - this allows the system to access the original message content for follow-up actions.'
    }),
    supervisor: [
      { agent_role: "email_specialist", status: "not_initialized" },
      { agent_role: "sales_manager", status: "not_initialized" },
      { agent_role: "customer_service_manager", status: "not_initialized" }
    ],
    model: "gpt-4.1",
    modelType: "openai"
  });
}

// Main POST endpoint to analyze emails
export async function POST(request: NextRequest) {
  try {
    // Get and validate request data
    const requestData = await request.json();
    console.log('[EMAIL_API] Request data received:', JSON.stringify(requestData, null, 2));
    
    // Normalizar datos del request para aceptar tanto camelCase como snake_case
    const normalizedData = CaseConverterService.normalizeRequestData(requestData, 'snake');
    console.log('[EMAIL_API] Normalized data:', JSON.stringify(normalizedData, null, 2));
    
    const validationResult = EmailAgentRequestSchema.safeParse(normalizedData);
    
    if (!validationResult.success) {
      console.error("[EMAIL_API] Validation error details:", JSON.stringify({
        error: validationResult.error.format(),
        issues: validationResult.error.issues,
      }, null, 2));
      
      return NextResponse.json(
        {
          success: false,
          error: {
            code: ERROR_CODES.INVALID_REQUEST,
            message: "Parámetros de solicitud inválidos",
            details: validationResult.error.format(),
          },
        },
        { status: 400 }
      );
    }
    
    console.log('[EMAIL_API] Validation successful, parsed data:', JSON.stringify(validationResult.data, null, 2));
    
    // Extraer parámetros usando getFlexibleProperty para máxima compatibilidad
    const siteId = getFlexibleProperty(requestData, 'site_id') || validationResult.data.site_id;
    const limit = getFlexibleProperty(requestData, 'limit') || validationResult.data.limit || 10;
    const leadId = getFlexibleProperty(requestData, 'lead_id') || validationResult.data.lead_id;
    const agentId = getFlexibleProperty(requestData, 'agentId') || getFlexibleProperty(requestData, 'agent_id') || validationResult.data.agentId;
    const teamMemberId = getFlexibleProperty(requestData, 'team_member_id') || validationResult.data.team_member_id;
    const analysisType = getFlexibleProperty(requestData, 'analysis_type') || validationResult.data.analysis_type;
    const userId = getFlexibleProperty(requestData, 'user_id') || validationResult.data.user_id;
    const sinceDate = getFlexibleProperty(requestData, 'since_date') || validationResult.data.since_date;
    
    console.log('[EMAIL_API] Extracted parameters:', {
      siteId, limit, leadId, agentId, teamMemberId, analysisType, userId, sinceDate
    });
    
    try {
      // Get email configuration
      console.log(`[EMAIL_API] 🔧 Obteniendo configuración de email para sitio: ${siteId}`);
      const emailConfig = await EmailConfigService.getEmailConfig(siteId);
      console.log(`[EMAIL_API] ✅ Configuración de email obtenida exitosamente`);
      
      // Fetch emails
      console.log(`[EMAIL_API] 📥 Obteniendo emails con límite: ${limit}, desde: ${sinceDate || 'sin límite de fecha'}`);
      const allEmails = await EmailService.fetchEmails(emailConfig, limit, sinceDate);
      console.log(`[EMAIL_API] ✅ Emails obtenidos exitosamente: ${allEmails.length} emails`);
      
      // Add diagnostic checkpoint
      console.log(`[EMAIL_API] 🔍 CHECKPOINT 1: Iniciando procesamiento de emails obtenidos...`);
      
      // CRITICAL: Filter emails by size to prevent memory issues
      console.log(`[EMAIL_API] 🔍 Verificando tamaños de emails para prevenir problemas de memoria...`);
      const MAX_EMAIL_SIZE = 50000; // 50KB máximo por email
      const originalEmailCount = allEmails.length;
      
      const sizeFilteredEmails = allEmails.filter((email, index) => {
        const emailSize = JSON.stringify(email).length;
        if (emailSize > MAX_EMAIL_SIZE) {
          console.log(`[EMAIL_API] 🚫 Email ${index + 1} excede tamaño máximo: ${emailSize} caracteres (máximo: ${MAX_EMAIL_SIZE})`);
          console.log(`[EMAIL_API] 🚫 Email excluido - From: ${email.from}, Subject: ${email.subject}`);
          return false;
        }
        return true;
      });
      
      console.log(`[EMAIL_API] 📊 Filtro de tamaño completado: ${sizeFilteredEmails.length}/${originalEmailCount} emails dentro del límite de tamaño`);
      
      // Reemplazar allEmails con los emails filtrados por tamaño
      const processableEmails = sizeFilteredEmails;
      console.log(`[EMAIL_API] 🔍 CHECKPOINT 1.5: Filtro de tamaño completado, continuando con ${processableEmails.length} emails...`);
      
      // Validación inicial: logs de configuración de no-reply
      console.log(`[EMAIL_API] 🔒 Configuración de filtros de seguridad:`);
      const noReplyAddresses = getNoReplyAddresses();
      console.log(`[EMAIL_API] - Direcciones no-reply configuradas: ${noReplyAddresses.join(', ')}`);
      console.log(`[EMAIL_API] - Variables de entorno detectadas:`, {
        EMAIL_FROM: process.env.EMAIL_FROM ? '✅ Configurado' : '❌ No configurado',
        SENDGRID_FROM_EMAIL: process.env.SENDGRID_FROM_EMAIL ? '✅ Configurado' : '❌ No configurado',
        NO_REPLY_EMAILS: process.env.NO_REPLY_EMAILS ? '✅ Configurado' : '❌ No configurado'
      });
      
      console.log(`[EMAIL_API] 🔍 CHECKPOINT 2: Configuración de seguridad completada...`);

      // Filter emails to avoid feedback loops (first filter) - with timeout
      console.log(`[EMAIL_API] 🔄 Aplicando filtro de feedback loops...`);
      const feedbackFilteredEmails = await Promise.race([
        Promise.resolve(filterFeedbackLoopEmails(processableEmails)),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout en filtro de feedback loops')), 30000))
      ]) as any[];
      console.log(`[EMAIL_API] ✅ Filtro de feedback loops completado: ${feedbackFilteredEmails.length}/${processableEmails.length} emails`);
      
      console.log(`[EMAIL_API] 🔍 CHECKPOINT 3: Filtro de feedback loops completado...`);
      
      // Find leads assigned to AI before filtering by aliases (second filter) - with timeout
      console.log(`[EMAIL_API] 🤖 Buscando leads asignados a la IA...`);
      const aiLeadsMap = await Promise.race([
        findLeadsAssignedToAI(feedbackFilteredEmails, siteId),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout buscando leads asignados a IA')), 30000))
      ]) as Map<string, any>;
      console.log(`[EMAIL_API] ✅ Leads asignados a la IA encontrados: ${aiLeadsMap.size}`);
      
      console.log(`[EMAIL_API] 🔍 CHECKPOINT 4: Búsqueda de leads IA completada...`);
      
      // Filter emails by aliases if configured (third filter)
      // Los aliases pueden venir como string separado por comas o como array
      console.log(`[EMAIL_API] 🔍 Procesando aliases de configuración...`);
      let normalizedAliases: string[] = [];
      
      if (emailConfig.aliases) {
        if (Array.isArray(emailConfig.aliases)) {
          normalizedAliases = emailConfig.aliases;
        } else {
          // Asumir que es un string separado por comas
          const aliasesStr = String(emailConfig.aliases);
          if (aliasesStr.trim().length > 0) {
            normalizedAliases = aliasesStr
              .split(',')
              .map((alias: string) => alias.trim())
              .filter((alias: string) => alias.length > 0);
          }
        }
      }
      
      console.log(`[EMAIL_API] 🔍 CHECKPOINT 5: Aliases procesados: ${normalizedAliases.length} encontrados...`);
      
      console.log(`[EMAIL_API] 🔍 Filtrando emails por aliases y leads asignados a la IA...`);
      const aliasFilteredEmails = await Promise.race([
        Promise.resolve(filterEmailsByAliasesAndAILeads(feedbackFilteredEmails, normalizedAliases, aiLeadsMap)),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout en filtro de aliases')), 30000))
      ]) as any[];
      console.log(`[EMAIL_API] ✅ Filtro de aliases completado: ${aliasFilteredEmails.length}/${feedbackFilteredEmails.length} emails`);
      
      console.log(`[EMAIL_API] 🔍 CHECKPOINT 6: Filtro de aliases completado...`);
      
      // Filter emails to avoid processing duplicates (fourth filter) - with timeout
      console.log(`[EMAIL_API] 🔄 Filtrando emails ya procesados para evitar duplicaciones...`);
      const filterResult = await Promise.race([
        SyncedObjectsService.filterUnprocessedEmails(aliasFilteredEmails, siteId, 'email'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout filtrando emails procesados')), 30000))
      ]) as { unprocessed: any[], alreadyProcessed: any[] };
      
      const { unprocessed: emails, alreadyProcessed } = filterResult;
      console.log(`[EMAIL_API] ✅ Filtro de duplicados completado: ${emails.length} sin procesar, ${alreadyProcessed.length} ya procesados`);
      
      console.log(`[EMAIL_API] 🔍 CHECKPOINT 7: Filtro de duplicados completado...`);

      console.log(`[EMAIL_API] 📈 Resumen de filtrado:`);
      console.log(`[EMAIL_API] - Emails obtenidos inicialmente: ${originalEmailCount}`);
      console.log(`[EMAIL_API] - Emails después del filtro de tamaño: ${processableEmails.length}`);
      console.log(`[EMAIL_API] - Emails después del filtro de feedback loops: ${feedbackFilteredEmails.length}`);
      console.log(`[EMAIL_API] - Emails después del filtrado por aliases: ${aliasFilteredEmails.length}`);
      console.log(`[EMAIL_API] - Emails ya procesados (duplicados evitados): ${alreadyProcessed.length}`);
      console.log(`[EMAIL_API] - Emails finales para análisis: ${emails.length}`);
      console.log(`[EMAIL_API] - Leads asignados a IA encontrados: ${aiLeadsMap.size}`);
      console.log(`[EMAIL_API] - Aliases configurados: ${normalizedAliases.length > 0 ? normalizedAliases.join(', ') : 'Ninguno (procesar todos)'}`);

      console.log(`[EMAIL_API] 🔍 CHECKPOINT 8: Resumen de filtrado completado...`);

      // Validación temprana: si no hay emails para analizar, retornar inmediatamente
      if (emails.length === 0) {
        console.log(`[EMAIL_API] ⚠️ No se encontraron emails para analizar después del filtrado`);
        
        // Obtener estadísticas de procesamiento para mejor reporte
        console.log(`[EMAIL_API] 🔍 CHECKPOINT 9: Obteniendo estadísticas de procesamiento...`);
        const stats = await Promise.race([
          SyncedObjectsService.getProcessingStats(siteId, 'email'),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout obteniendo estadísticas')), 10000))
        ]);
        console.log(`[EMAIL_API] 🔍 CHECKPOINT 10: Estadísticas obtenidas, retornando respuesta temprana...`);
        
        return NextResponse.json({
          success: true,
          data: {
            commandId: null,
            status: 'completed',
            message: "No se encontraron emails para analizar en el período especificado",
            emailCount: 0,
            originalEmailCount: originalEmailCount,
            sizeFilteredCount: processableEmails.length,
            feedbackLoopFilteredCount: feedbackFilteredEmails.length,
            aliasFilteredCount: aliasFilteredEmails.length,
            alreadyProcessedCount: alreadyProcessed.length,
            analysisCount: 0,
            aliasesConfigured: normalizedAliases,
            filteredBySize: originalEmailCount > processableEmails.length,
            filteredByAliases: normalizedAliases.length > 0,
            filteredByFeedbackLoop: processableEmails.length > feedbackFilteredEmails.length,
            filteredByDuplicates: alreadyProcessed.length > 0,
            processingStats: stats,
            emails: [],
            reason: originalEmailCount === 0 ? 'No hay emails nuevos en el buzón' : 
                    processableEmails.length === 0 ? 'Todos los emails fueron filtrados por tamaño excesivo' :
                    feedbackFilteredEmails.length === 0 ? 'Todos los emails fueron filtrados como feedback loops' :
                    aliasFilteredEmails.length === 0 ? 'Ningún email coincide con los aliases configurados' :
                    emails.length === 0 ? 'Todos los emails ya han sido procesados previamente' :
                    'Todos los emails fueron bloqueados por validaciones de seguridad'
          }
        });
      }

      console.log(`[EMAIL_API] 🔍 CHECKPOINT 11: Continuando con validación de seguridad...`);

      // Validación de seguridad final usando EmailFilterService - with timeout
      console.log(`[EMAIL_API] 🔒 Ejecutando validación de seguridad final con EmailFilterService...`);
      
      const securityResult = await Promise.race([
        Promise.resolve(EmailFilterService.filterValidEmails(emails, noReplyAddresses)),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout en validación de seguridad')), 30000))
      ]) as { validEmails: any[], filteredEmails: any[] };
      
      const { validEmails: safeEmails, filteredEmails: unsafeEmails } = securityResult;
      console.log(`[EMAIL_API] ✅ Validación de seguridad completada: ${safeEmails.length}/${emails.length} emails seguros`);
      
      console.log(`[EMAIL_API] 🔍 CHECKPOINT 12: Validación de seguridad completada...`);
      
      if (unsafeEmails.length > 0) {
        console.warn(`[EMAIL_API] 🚨 ADVERTENCIA: Se detectaron ${unsafeEmails.length} emails no válidos que pasaron el filtro inicial`);
        
        // Agrupar por categoría para mejor reporte - with timeout
        const categorizedEmails = await Promise.race([
          Promise.resolve(EmailFilterService.getFilteringStats(unsafeEmails)),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout obteniendo estadísticas de filtrado')), 5000))
        ]);
        console.warn(`[EMAIL_API] 📊 Estadísticas de filtrado:`, categorizedEmails);
        
        // Log detallado por categoría
        const emailsByCategory: Record<string, Array<{ email: any, reason: string }>> = {};
        unsafeEmails.forEach(({ email, reason, category }) => {
          if (!emailsByCategory[category]) emailsByCategory[category] = [];
          emailsByCategory[category].push({ email, reason });
        });
        
        Object.entries(emailsByCategory).forEach(([category, emailsInCategory]) => {
          console.warn(`[EMAIL_API] 📋 Emails ${category} bloqueados (${emailsInCategory.length}):`, emailsInCategory);
        });
      }

      console.log(`[EMAIL_API] 🔍 CHECKPOINT 13: Manejo de emails no seguros completado...`);

      // Usar safeEmails en lugar de emails para el resto del proceso
      const finalEmailsForAnalysis = safeEmails;

      if (finalEmailsForAnalysis.length === 0) {
        console.log(`[EMAIL_API] ⚠️ No quedan emails seguros para analizar después de las validaciones de seguridad`);
        
        // Obtener estadísticas de procesamiento para mejor reporte
        console.log(`[EMAIL_API] 🔍 CHECKPOINT 14: Obteniendo estadísticas para respuesta sin emails seguros...`);
        const stats = await Promise.race([
          SyncedObjectsService.getProcessingStats(siteId, 'email'),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout obteniendo estadísticas finales')), 10000))
        ]);
        console.log(`[EMAIL_API] 🔍 CHECKPOINT 15: Retornando respuesta sin emails seguros...`);
        
        return NextResponse.json({
          success: true,
          data: {
            commandId: null,
            status: 'completed',
            message: "No se encontraron emails seguros para analizar después de las validaciones de seguridad",
            emailCount: 0,
            originalEmailCount: originalEmailCount,
            sizeFilteredCount: processableEmails.length,
            feedbackLoopFilteredCount: feedbackFilteredEmails.length,
            aliasFilteredCount: aliasFilteredEmails.length,
            alreadyProcessedCount: alreadyProcessed.length,
            unsafeEmailsBlocked: unsafeEmails.length,
            analysisCount: 0,
            aliasesConfigured: normalizedAliases,
            filteredBySize: originalEmailCount > processableEmails.length,
            filteredByAliases: normalizedAliases.length > 0,
            filteredByFeedbackLoop: processableEmails.length > feedbackFilteredEmails.length,
            filteredByDuplicates: alreadyProcessed.length > 0,
            filteredBySecurity: unsafeEmails.length > 0,
            securityValidation: {
              detected: unsafeEmails.length,
              categories: EmailFilterService.getFilteringStats(unsafeEmails),
              reasons: unsafeEmails.map(u => u.reason)
            },
            processingStats: stats,
            emails: [],
            reason: originalEmailCount === 0 ? 'No hay emails nuevos en el buzón' : 
                    processableEmails.length === 0 ? 'Todos los emails fueron filtrados por tamaño excesivo' :
                    feedbackFilteredEmails.length === 0 ? 'Todos los emails fueron filtrados como feedback loops' :
                    aliasFilteredEmails.length === 0 ? 'Ningún email coincide con los aliases configurados' :
                    emails.length === 0 ? 'Todos los emails ya han sido procesados previamente' :
                    'Todos los emails fueron bloqueados por validaciones de seguridad'
          }
        });
      }

      console.log(`[EMAIL_API] 🔍 CHECKPOINT 16: Continuando con búsqueda de agente...`);

      // Si no se proporciona agentId, buscar el agente de soporte - with timeout
      console.log(`[EMAIL_API] 🔍 Determinando agente ID efectivo...`);
      const effectiveAgentId = agentId || await Promise.race([
        findSupportAgent(siteId),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout buscando agente de soporte')), 15000))
      ]);
      console.log(`[EMAIL_API] ✅ Agente ID efectivo: ${effectiveAgentId}`);
      
      console.log(`[EMAIL_API] 🔍 CHECKPOINT 17: Agente determinado, creando comando...`);
      
      // Create and submit command
      console.log(`[EMAIL_API] 🔧 Creando comando de análisis de emails...`);
      const command = createEmailCommand(effectiveAgentId, siteId, finalEmailsForAnalysis, emailConfig, analysisType, leadId, teamMemberId, userId);
      console.log(`[EMAIL_API] 🔍 CHECKPOINT 18: Comando creado, enviando al servicio...`);
      
      console.log(`[EMAIL_API] 📤 Enviando comando al servicio...`);
      const internalCommandId = await Promise.race([
        commandService.submitCommand(command),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout enviando comando')), 30000))
      ]);
      
      console.log(`📝 Comando creado con ID interno: ${internalCommandId}`);
      console.log(`[EMAIL_API] 🔍 CHECKPOINT 19: Comando enviado exitosamente...`);
      
      // Intentar obtener el UUID de la base de datos inmediatamente después de crear el comando
      console.log(`[EMAIL_API] 🔍 CHECKPOINT 20: Obteniendo UUID de base de datos...`);
      let initialDbUuid = await Promise.race([
        getCommandDbUuid(internalCommandId),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout obteniendo UUID inicial')), 10000))
      ]).catch(error => {
        console.warn(`[EMAIL_API] ⚠️ No se pudo obtener UUID inicial: ${error.message}`);
        return null;
      });
      
      if (initialDbUuid) {
        console.log(`📌 UUID de base de datos obtenido inicialmente: ${initialDbUuid}`);
      }
      console.log(`[EMAIL_API] 🔍 CHECKPOINT 21: UUID de BD procesado, esperando ejecución...`);
      
      // Esperar a que el comando se complete utilizando nuestra función (igual que chat)
      console.log(`[EMAIL_API] ⏳ Esperando a que el comando se complete...`);
      const { command: executedCommand, dbUuid, completed } = await waitForCommandCompletion(internalCommandId, 200, 1000); // 200 intentos x 1s = máx 200s, dejando 100s para el resto
      
      console.log(`[EMAIL_API] 🔍 CHECKPOINT 22: Comando completado o timeout alcanzado...`);
      
      // Usar el UUID obtenido inicialmente si no tenemos uno válido después de la ejecución
      const effectiveDbUuid = (dbUuid && isValidUUID(dbUuid)) ? dbUuid : initialDbUuid;
      
      console.log(`[EMAIL_API] 🔍 CHECKPOINT 23: UUID efectivo determinado: ${effectiveDbUuid || 'No disponible'}...`);
      
      // Si no completado y no hay resultados, retornar error
      if (!completed) {
        console.warn(`⚠️ Comando ${internalCommandId} no completó exitosamente en el tiempo esperado`);
        
        if (!executedCommand || !executedCommand.results || executedCommand.results.length === 0) {
          console.log(`[EMAIL_API] 🔍 CHECKPOINT 24: Comando falló sin resultados, retornando error...`);
          // Solo fallar si realmente no hay resultados utilizables
          return NextResponse.json(
            { 
              success: false, 
              error: { 
                code: 'COMMAND_EXECUTION_FAILED', 
                message: 'El comando no completó exitosamente y no se generaron resultados válidos' 
              } 
            },
            { status: 500 }
          );
        } else {
          // Si hay resultados a pesar del estado, continuamos con advertencia
          console.log(`⚠️ Comando en estado ${executedCommand.status} pero tiene ${executedCommand.results.length} resultados, continuando`);
        }
      }
      
      console.log(`[EMAIL_API] 🔍 CHECKPOINT 25: Procesando resultados del comando...`);
      
      // Extraer los datos de email de los results para incluir en la respuesta
      // NOTA: Solo extraemos de results, NO de targets (que contienen solo templates)
      const emailsForResponse: any[] = [];
      const processedEmailIds: string[] = [];
      
      console.log(`[EMAIL_API] 🔍 Diagnosticando comando ejecutado:`);
      console.log(`[EMAIL_API] executedCommand existe: ${!!executedCommand}`);
      console.log(`[EMAIL_API] executedCommand.results existe: ${!!(executedCommand && executedCommand.results)}`);
      console.log(`[EMAIL_API] executedCommand.results es array: ${!!(executedCommand && executedCommand.results && Array.isArray(executedCommand.results))}`);
      console.log(`[EMAIL_API] executedCommand.results.length: ${executedCommand?.results?.length || 0}`);
      
      console.log(`[EMAIL_API] 🔍 CHECKPOINT 26: Diagnóstico de comando completado...`);
      
      if (executedCommand) {
        console.log(`[EMAIL_API] 📋 Estructura completa del comando:`, JSON.stringify({
          status: executedCommand.status,
          results: executedCommand.results,
          targets: executedCommand.targets,
          resultsCount: executedCommand.results?.length || 0,
          targetsCount: executedCommand.targets?.length || 0
        }, null, 2));
      }
      
      console.log(`[EMAIL_API] 🔍 CHECKPOINT 27: Logs de estructura completados...`);
      
      // Función para validar si un email contiene tokens de instrucciones
      const containsInstructionTokens = (email: any): boolean => {
        const tokenPatterns = [
          'email_id_from_context',
          'Original subject of the email',
          'Original email content/message as received',
          'Summary of the message and client inquiry',
          'name found in the email',
          'from email address',
          'phone found in the email',
          'company found in the email',
          'original_subject',
          'original_text',
          'contact_info'
        ];
        
        const emailStr = JSON.stringify(email).toLowerCase();
        
        return tokenPatterns.some(pattern => 
          emailStr.includes(pattern.toLowerCase())
        );
      };

      // Extraer SOLO de results (que contienen los emails procesados por el agente)
      if (executedCommand && executedCommand.results && Array.isArray(executedCommand.results)) {
        console.log(`[EMAIL_API] 🔄 Iterando sobre ${executedCommand.results.length} resultados...`);
        console.log(`[EMAIL_API] 🔍 CHECKPOINT 28: Iniciando extracción de emails de resultados...`);
        
        for (const result of executedCommand.results) {
          console.log(`[EMAIL_API] 📧 Resultado encontrado:`, JSON.stringify(result, null, 2));
          if (result.email) {
            // Validar si el email contiene tokens de instrucciones
            if (containsInstructionTokens(result.email)) {
              console.log(`[EMAIL_API] 🚫 Email rechazado - contiene tokens de instrucciones:`, JSON.stringify(result.email, null, 2));
              continue; // Saltar este email
            }
            
            console.log(`[EMAIL_API] ✅ Email encontrado en results:`, JSON.stringify(result.email, null, 2));
            emailsForResponse.push(result.email);
            
            // Recopilar IDs de emails procesados para marcarlos como completados
            if (result.email.id) {
              processedEmailIds.push(result.email.id);
            }
          } else {
            console.log(`[EMAIL_API] ❌ Result no tiene propiedad email:`, Object.keys(result));
          }
        }
        console.log(`[EMAIL_API] 🔍 CHECKPOINT 29: Extracción de emails completada...`);
      } else {
        console.log(`[EMAIL_API] ❌ No se encontraron results válidos para procesar`);
        console.log(`[EMAIL_API] 🔍 CHECKPOINT 30: Sin resultados válidos para procesar...`);
      }
      
      // NO extraer de targets ya que contienen solo templates/placeholders
      // Los targets son la estructura esperada, no los resultados reales
      
      console.log(`[EMAIL_API] 📊 Emails extraídos para respuesta: ${emailsForResponse.length}`);
      console.log(`[EMAIL_API] 📝 IDs de emails para marcar como procesados: ${processedEmailIds.length}`);
      console.log(`[EMAIL_API] 🔍 CHECKPOINT 31: Iniciando marcado de emails como procesados...`);
      
      // Marcar emails analizados como procesados en paralelo
      console.log(`[EMAIL_API] 🔄 Marcando emails como procesados...`);
      const markingPromises = processedEmailIds.map(async (emailId) => {
        try {
          const marked = await SyncedObjectsService.markAsProcessed(emailId, siteId, {
            command_id: effectiveDbUuid || internalCommandId,
            analysis_timestamp: new Date().toISOString(),
            agent_id: effectiveAgentId
          });
          if (marked) {
            console.log(`[EMAIL_API] ✅ Email ${emailId} marcado como procesado`);
          } else {
            console.log(`[EMAIL_API] ⚠️ No se pudo marcar email ${emailId} como procesado`);
          }
          return marked;
        } catch (error) {
          console.error(`[EMAIL_API] ❌ Error marcando email ${emailId} como procesado:`, error);
          return false;
        }
      });
      
      console.log(`[EMAIL_API] 🔍 CHECKPOINT 32: Promesas de marcado de emails procesados creadas...`);
      
      // Marcar todos los emails que fueron enviados al agente pero no tuvieron respuesta como "procesados" también
      const allEmailIds = finalEmailsForAnalysis.map((email: any) => email.id || email.messageId || email.uid).filter(Boolean);
      const unprocessedEmailIds = allEmailIds.filter(id => !processedEmailIds.includes(id));
      
      console.log(`[EMAIL_API] 📝 Marcando ${unprocessedEmailIds.length} emails sin respuesta como procesados...`);
      const unprocessedPromises = unprocessedEmailIds.map(async (emailId) => {
        try {
          const marked = await SyncedObjectsService.markAsProcessed(emailId, siteId, {
            command_id: effectiveDbUuid || internalCommandId,
            analysis_timestamp: new Date().toISOString(),
            agent_id: effectiveAgentId,
            status: 'no_action_required'
          });
          if (marked) {
            console.log(`[EMAIL_API] ✅ Email ${emailId} marcado como procesado (sin acción requerida)`);
          }
          return marked;
        } catch (error) {
          console.error(`[EMAIL_API] ❌ Error marcando email ${emailId} como procesado:`, error);
          return false;
        }
      });
      
      console.log(`[EMAIL_API] 🔍 CHECKPOINT 33: Promesas de marcado de emails sin respuesta creadas...`);
      
      // Esperar a que todas las operaciones de marcado se completen
      const markingResults = await Promise.race([
        Promise.all([...markingPromises, ...unprocessedPromises]),
        new Promise<boolean[]>((_, reject) => setTimeout(() => reject(new Error('Timeout marcando emails')), 30000))
      ]).catch(error => {
        console.error(`[EMAIL_API] ❌ Error/timeout marcando emails:`, error.message);
        return [] as boolean[];
      });
      
      const successfulMarks = markingResults.filter(Boolean).length;
      console.log(`[EMAIL_API] 📊 Marcado completado: ${successfulMarks}/${markingResults.length} emails actualizados`);
      console.log(`[EMAIL_API] 🔍 CHECKPOINT 34: Marcado de emails completado...`);
      
      // Obtener estadísticas actualizadas
      console.log(`[EMAIL_API] 🔍 CHECKPOINT 35: Obteniendo estadísticas finales...`);
      const finalStats = await Promise.race([
        SyncedObjectsService.getProcessingStats(siteId, 'email'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout obteniendo estadísticas finales')), 10000))
      ]).catch(error => {
        console.error(`[EMAIL_API] ❌ Error obteniendo estadísticas finales:`, error.message);
        return null;
      });
      
      console.log(`[EMAIL_API] 🔍 CHECKPOINT 36: Preparando respuesta final...`);
      
      return NextResponse.json({
        success: true,
        data: {
          commandId: effectiveDbUuid || internalCommandId,
          status: executedCommand?.status || 'completed',
          message: "Análisis de emails completado exitosamente",
          emailCount: finalEmailsForAnalysis.length,
          originalEmailCount: originalEmailCount,
          sizeFilteredCount: processableEmails.length,
          feedbackLoopFilteredCount: feedbackFilteredEmails.length,
          aliasFilteredCount: aliasFilteredEmails.length,
          alreadyProcessedCount: alreadyProcessed.length,
          unsafeEmailsBlocked: unsafeEmails.length,
          analysisCount: emailsForResponse.length,
          processedEmailsMarked: successfulMarks,
          aliasesConfigured: normalizedAliases,
          filteredBySize: originalEmailCount > processableEmails.length,
          filteredByAliases: normalizedAliases.length > 0,
          filteredByFeedbackLoop: processableEmails.length > feedbackFilteredEmails.length,
          filteredByDuplicates: alreadyProcessed.length > 0,
          filteredBySecurity: unsafeEmails.length > 0,
          securityValidation: {
            detected: unsafeEmails.length,
            categories: EmailFilterService.getFilteringStats(unsafeEmails),
            reasons: unsafeEmails.map(u => u.reason),
            noReplyAddressesConfigured: noReplyAddresses
          },
          processingStats: finalStats,
          emails: emailsForResponse
        }
      });
      
    } catch (error: unknown) {
      console.error(`[EMAIL_API] 💥 Error en el flujo principal:`, error);
      console.error(`[EMAIL_API] 📋 Detalles del error:`, {
        name: error instanceof Error ? error.name : 'Unknown',
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : 'No stack trace'
      });
      
      const isConfigError = error instanceof Error && (
        error.message.includes('settings') || 
        error.message.includes('token')
      );

      const isAgentError = error instanceof Error && 
        error.message.includes('agente de soporte');
        
      const errorCode = isConfigError ? ERROR_CODES.EMAIL_CONFIG_NOT_FOUND : 
                       isAgentError ? ERROR_CODES.AGENT_NOT_FOUND :
                       ERROR_CODES.EMAIL_FETCH_ERROR;
      
      const errorMessage = error instanceof Error ? error.message : "Error procesando emails";
      
      console.error(`[EMAIL_API] 🚨 Retornando error: ${errorCode} - ${errorMessage}`);
      
      return NextResponse.json(
        {
          success: false,
          error: {
            code: errorCode,
            message: errorMessage,
          },
        },
        { status: isConfigError || isAgentError ? 404 : 500 }
      );
    }
  } catch (error: unknown) {
    return NextResponse.json({
      success: false,
      error: {
        code: ERROR_CODES.SYSTEM_ERROR,
        message: error instanceof Error ? error.message : "Error interno del sistema",
      }
    }, { status: 500 });
  }
}

// GET method for backward compatibility, returns an empty response with a message
export async function GET(request: NextRequest) {
  return NextResponse.json({
    success: true,
    data: {
      message: "This endpoint requires a POST request with email analysis parameters. Please refer to the documentation."
    }
  }, { status: 200 });
}

// Función de validación de email
function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
} 