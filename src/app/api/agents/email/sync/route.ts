/**
 * API de Email Sync - Sincroniza emails enviados con leads y conversaciones
 * Route: POST /api/agents/email/sync
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { EmailService } from '@/lib/services/email/EmailService';
import { EmailConfigService } from '@/lib/services/email/EmailConfigService';
import { cleanHtmlContent } from '@/lib/utils/html-content-cleaner';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { CaseConverterService, getFlexibleProperty } from '@/lib/utils/case-converter';
import { ConversationService } from '@/lib/services/conversation-service';
import { createTask } from '@/lib/database/task-db';
import { SyncedObjectsService } from '@/lib/services/synced-objects/SyncedObjectsService';
import { EmailTextExtractorService } from '@/lib/services/email/EmailTextExtractorService';
import { StableEmailDeduplicationService } from '@/lib/utils/stable-email-deduplication';
import { SentEmailDuplicationService } from '@/lib/services/email/SentEmailDuplicationService';
import { EmailSyncErrorService } from '@/lib/services/email/EmailSyncErrorService';
import { SiteEmailGuardService } from '@/lib/services/email/SiteEmailGuardService';

// Configuración de timeout extendido para Vercel
export const maxDuration = 800; // 13.33 minutos en segundos (máximo para plan Pro)

// Create schemas for request validation
const EmailSyncRequestSchema = z.object({
  site_id: z.string().min(1, "Site ID is required"),
  limit: z.number().default(10).optional(),
  since_date: z.string().optional().refine(
    (date) => !date || !isNaN(Date.parse(date)),
    "since_date debe ser una fecha válida en formato ISO"
  ),
  // También aceptar 'since' para compatibilidad con workflows
  since: z.string().optional().refine(
    (date) => !date || !isNaN(Date.parse(date)),
    "since debe ser una fecha válida en formato ISO"
  ),
});

// Error codes
const ERROR_CODES = {
  INVALID_REQUEST: 'INVALID_REQUEST',
  EMAIL_CONFIG_NOT_FOUND: 'EMAIL_CONFIG_NOT_FOUND',
  EMAIL_FETCH_ERROR: 'EMAIL_FETCH_ERROR',
  SYSTEM_ERROR: 'SYSTEM_ERROR',
};

// Función para validar UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

/**
 * Valida que un ID de email sea válido y suficientemente único
 */
function isValidEmailId(emailId: any): boolean {
  // Verificar que sea string válido
  if (!emailId || typeof emailId !== 'string') {
    return false;
  }

  const trimmedId = emailId.trim();
  
  // Verificar longitud mínima
  if (trimmedId.length < 3) {
    return false;
  }
  
  // Verificar que no sea un ID demasiado genérico o común
  const genericIds = /^(1|2|3|4|5|6|7|8|9|0|test|temp|undefined|null|msg|email|id)$/i;
  if (genericIds.test(trimmedId)) {
    return false;
  }
  
  // Verificar que no sean solo números simples (1-100)
  if (/^\d{1,2}$/.test(trimmedId) && parseInt(trimmedId) <= 100) {
    return false;
  }
  
  return true;
}

/**
 * Extrae y valida el ID más confiable de un email siguiendo RFC 5322
 * Este es el ESTÁNDAR que usamos tanto para guardar como para buscar duplicados
 */
function extractValidEmailId(email: any): string | null {
  const candidates = [
    email.messageId, // 🎯 PRIORIZAR Message-ID para correlación perfecta (RFC 5322)
    email.id,
    email.uid,
    email.message_id,
    email.Message_ID,
    email.ID
  ];
  
  for (const candidate of candidates) {
    if (isValidEmailId(candidate)) {
      return candidate.trim();
    }
  }
  
  return null;
}

/**
 * Busca un mensaje existente usando el MISMO estándar de ID que usamos para guardar
 * Busca en TODOS los campos donde podríamos haber guardado el extractValidEmailId
 */
async function findExistingMessageByStandardId(
  conversationId: string,
  leadId: string,
  standardEmailId: string
): Promise<string | null> {
  if (!standardEmailId) return null;
  
  console.log(`[EMAIL_SYNC] 🔍 Buscando mensaje existente con ID estándar: "${standardEmailId}"`);
  
  try {
    // Buscar en TODOS los campos donde guardamos el extractValidEmailId
    const searchQueries = [
      // Campo principal actual
      supabaseAdmin
        .from('messages')
        .select('id')
        .eq('conversation_id', conversationId)
        .eq('lead_id', leadId)
        .filter('custom_data->>email_id', 'eq', standardEmailId)
        .limit(1),
      
      // Campo en delivery.details (formato actual)
      supabaseAdmin
        .from('messages')
        .select('id')
        .eq('conversation_id', conversationId)
        .eq('lead_id', leadId)
        .filter('custom_data->delivery->>details->>api_messageId', 'eq', standardEmailId)
        .limit(1),
      
      // Campo legacy external_message_id
      supabaseAdmin
        .from('messages')
        .select('id')
        .eq('conversation_id', conversationId)
        .eq('lead_id', leadId)
        .filter('custom_data->delivery->>external_message_id', 'eq', standardEmailId)
        .limit(1),
        
      // Campo legacy en delivery.details
      supabaseAdmin
        .from('messages')
        .select('id')
        .eq('conversation_id', conversationId)
        .eq('lead_id', leadId)
        .filter('custom_data->delivery->>details->>external_message_id', 'eq', standardEmailId)
        .limit(1)
    ];
    
    // Ejecutar todas las búsquedas en paralelo
    const results = await Promise.allSettled(searchQueries);
    
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.data && result.value.data.length > 0) {
        const foundMessageId = result.value.data[0].id;
        console.log(`[EMAIL_SYNC] ✅ DUPLICADO ENCONTRADO por ID estándar "${standardEmailId}": ${foundMessageId}`);
        return foundMessageId;
      }
    }
    
    console.log(`[EMAIL_SYNC] ✅ No hay duplicados con ID estándar: "${standardEmailId}"`);
    return null;
  } catch (error) {
    console.error('[EMAIL_SYNC] Error buscando por ID estándar:', error);
    return null;
  }
}

/**
 * Obtiene los dominios internos de Uncodie que deben ser filtrados
 */
function getInternalDomains(): string[] {
  const domains = [
    // Dominios principales de Uncodie
    'uncodie.com',
    'www.uncodie.com',
    'api.uncodie.com',
    'app.uncodie.com',
    
    // Extraer dominios de variables de entorno
    process.env.UNCODIE_SUPPORT_EMAIL,
    process.env.EMAIL_FROM,
    process.env.SENDGRID_FROM_EMAIL,
    process.env.NO_REPLY_EMAILS
  ].filter(Boolean);

  // Expandir emails separados por comas y extraer dominios
  const expandedDomains: string[] = [];
  domains.forEach(item => {
    if (item && typeof item === 'string') {
      if (item.includes(',')) {
        // Dividir emails separados por comas
        item.split(',').forEach(email => {
          const domain = extractDomainFromEmail(email.trim());
          if (domain) expandedDomains.push(domain);
        });
      } else if (item.includes('@')) {
        // Es un email, extraer dominio
        const domain = extractDomainFromEmail(item);
        if (domain) expandedDomains.push(domain);
      } else {
        // Es un dominio directo
        expandedDomains.push(item.toLowerCase().trim());
      }
    }
  });

  // Remover duplicados y añadir dominios base
  const allDomains = [
    'uncodie.com',
    'www.uncodie.com',
    'api.uncodie.com', 
    'app.uncodie.com',
    ...expandedDomains
  ];

  return Array.from(new Set(allDomains.map(d => d.toLowerCase().trim())));
}

/**
 * Extrae el dominio de una dirección de email
 */
function extractDomainFromEmail(email: string): string | null {
  if (!email || typeof email !== 'string') return null;
  
  // Remover espacios y caracteres especiales
  const cleanEmail = email.trim().toLowerCase();
  
  // Extraer email de formato "Name <email@domain.com>"
  const emailMatch = cleanEmail.match(/<([^>]+)>/);
  const finalEmail = emailMatch ? emailMatch[1] : cleanEmail;
  
  // Dividir por @ y tomar la parte del dominio
  const parts = finalEmail.split('@');
  if (parts.length === 2) {
    return parts[1].trim();
  }
  
  return null;
}

/**
 * Valida que un email no sea enviado a dominios internos de Uncodie
 */
function validateEmailNotToInternalDomains(email: any): { isValid: boolean, reason?: string } {
  const emailTo = email.to || '';
  
  if (!emailTo || typeof emailTo !== 'string') {
    return { isValid: true };
  }

  const internalDomains = getInternalDomains();
  const targetDomain = extractDomainFromEmail(emailTo);

  if (!targetDomain) {
    return { isValid: true };
  }

  // Verificar contra dominios internos
  for (const internalDomain of internalDomains) {
    if (!internalDomain) continue;
    
    const normalizedInternalDomain = internalDomain.toLowerCase().trim();
    const normalizedTargetDomain = targetDomain.toLowerCase().trim();
    
    // Verificar coincidencia exacta
    if (normalizedTargetDomain === normalizedInternalDomain) {
      return {
        isValid: false,
        reason: `Email enviado a dominio interno: ${normalizedInternalDomain}`
      };
    }
    
    // Verificar subdominios de uncodie.com
    if (normalizedInternalDomain === 'uncodie.com' && normalizedTargetDomain.endsWith('.uncodie.com')) {
      return {
        isValid: false,
        reason: `Email enviado a subdominio de Uncodie: ${normalizedTargetDomain}`
      };
    }
  }

  return { isValid: true };
}

/**
 * Función para buscar un lead por email
 */
async function findLeadByEmail(email: string, siteId: string): Promise<string | null> {
  try {
    console.log(`[EMAIL_SYNC] 🔍 Buscando lead por email: ${email} en sitio: ${siteId}`);
    
    const { data, error } = await supabaseAdmin
      .from('leads')
      .select('id')
      .eq('email', email)
      .eq('site_id', siteId)
      .limit(1);
    
    if (error) {
      console.error('[EMAIL_SYNC] Error al buscar lead por email:', error);
      return null;
    }
    
    if (!data || data.length === 0) {
      console.log(`[EMAIL_SYNC] ⚠️ No se encontró lead con email: ${email}`);
      return null;
    }
    
    console.log(`[EMAIL_SYNC] ✅ Lead encontrado con ID: ${data[0].id}`);
    return data[0].id;
  } catch (error) {
    console.error('[EMAIL_SYNC] Error al buscar lead por email:', error);
    return null;
  }
}

/**
 * Función para crear un nuevo lead basado en email enviado
 */
async function createLeadFromSentEmail(toEmail: string, siteId: string, emailSubject: string, emailObject?: any): Promise<string | null> {
  try {
    console.log(`[EMAIL_SYNC] ➕ Creando nuevo lead para email: ${toEmail} en sitio: ${siteId}`);
    
    // Obtener información del sitio para user_id
    const { data: site, error: siteError } = await supabaseAdmin
      .from('sites')
      .select('user_id')
      .eq('id', siteId)
      .single();
      
    if (siteError || !site) {
      console.error('[EMAIL_SYNC] Error al obtener información del sitio:', siteError);
      return null;
    }
    
    // Extraer nombre del contacto usando método mejorado
    const extractedName = emailObject ? extractContactName(emailObject, toEmail) : null;
    const leadName = extractedName || `Contact`;
    
    const leadData = {
      email: toEmail,
      name: leadName,
      status: 'contacted',
      origin: 'email',
      site_id: siteId,
      user_id: site.user_id,
      notes: `Lead creado automáticamente desde email enviado: "${emailSubject}"`
    };
    
    const { data, error } = await supabaseAdmin
      .from('leads')
      .insert([leadData])
      .select()
      .single();
      
    if (error) {
      console.error('[EMAIL_SYNC] Error al crear lead:', error);
      return null;
    }
    
    console.log(`[EMAIL_SYNC] ✅ Nuevo lead creado con ID: ${data.id}`);
    return data.id;
  } catch (error) {
    console.error('[EMAIL_SYNC] Error al crear lead:', error);
    return null;
  }
}

/**
 * Función para actualizar status del lead a 'contacted' si es necesario
 */
async function updateLeadStatusIfNeeded(leadId: string): Promise<boolean> {
  try {
    console.log(`[EMAIL_SYNC] 📝 Verificando status del lead: ${leadId}`);
    
    // Obtener status actual del lead
    const { data: lead, error: leadError } = await supabaseAdmin
      .from('leads')
      .select('status')
      .eq('id', leadId)
      .single();
      
    if (leadError || !lead) {
      console.error('[EMAIL_SYNC] Error al obtener lead:', leadError);
      return false;
    }
    
    // Si el status actual no es al menos 'contacted', actualizarlo
    const currentStatus = lead.status;
    const statusHierarchy = ['new', 'contacted', 'qualified', 'converted'];
    const currentIndex = statusHierarchy.indexOf(currentStatus);
    const contactedIndex = statusHierarchy.indexOf('contacted');
    
    if (currentIndex < contactedIndex || currentIndex === -1) {
      console.log(`[EMAIL_SYNC] 🔄 Actualizando status de '${currentStatus}' a 'contacted'`);
      
      const { error: updateError } = await supabaseAdmin
        .from('leads')
        .update({ 
          status: 'contacted',
          updated_at: new Date().toISOString()
        })
        .eq('id', leadId);
        
      if (updateError) {
        console.error('[EMAIL_SYNC] Error al actualizar status del lead:', updateError);
        return false;
      }
      
      console.log(`[EMAIL_SYNC] ✅ Status del lead actualizado a 'contacted'`);
      return true;
    } else {
      console.log(`[EMAIL_SYNC] ℹ️ Lead ya tiene status '${currentStatus}', no se actualiza`);
      return false;
    }
  } catch (error) {
    console.error('[EMAIL_SYNC] Error al actualizar status del lead:', error);
    return false;
  }
}

/**
 * Función para buscar o crear conversación de email para el lead
 */
async function findOrCreateEmailConversation(leadId: string, siteId: string, emailSubject?: string): Promise<string | null> {
  try {
    console.log(`[EMAIL_SYNC] 💬 Buscando conversación de email para lead: ${leadId}`);
    
    // Buscar conversación existente de email (últimos 30 días)
    const existingConversationId = await ConversationService.findExistingConversation(
      leadId,
      undefined, // visitorId
      siteId,
      'email' // origin/channel
    );
    
    if (existingConversationId) {
      console.log(`[EMAIL_SYNC] ✅ Conversación de email existente encontrada: ${existingConversationId}`);
      return existingConversationId;
    }
    
    // Crear nueva conversación de email
    console.log(`[EMAIL_SYNC] ➕ Creando nueva conversación de email para lead: ${leadId}`);
    
    // Obtener información del lead para el título
    const { data: lead, error: leadError } = await supabaseAdmin
      .from('leads')
      .select('name, email, user_id')
      .eq('id', leadId)
      .single();
      
    if (leadError || !lead) {
      console.error('[EMAIL_SYNC] Error al obtener información del lead para conversación:', leadError);
      return null;
    }
    
    // Usar el subject del email como título si está disponible, sino usar título por defecto
    const conversationTitle = emailSubject && emailSubject.trim() 
      ? fixTextEncoding(emailSubject.trim())
      : `Email Conversation - ${lead.name || lead.email}`;
    
    const conversationData = {
      lead_id: leadId,
      site_id: siteId,
      user_id: lead.user_id,
      channel: 'email',
      title: conversationTitle,
      status: 'active',
      custom_data: {
        channel: 'email',
        sync_source: 'sent_email'
      }
    };
    
    const { data: conversation, error: convError } = await supabaseAdmin
      .from('conversations')
      .insert([conversationData])
      .select()
      .single();
      
    if (convError) {
      console.error('[EMAIL_SYNC] Error al crear conversación:', convError);
      return null;
    }
    
    console.log(`[EMAIL_SYNC] ✅ Nueva conversación de email creada: ${conversation.id} con título: "${conversationTitle}"`);
    return conversation.id;
  } catch (error) {
    console.error('[EMAIL_SYNC] Error al buscar/crear conversación:', error);
    return null;
  }
}

/**
 * Función avanzada para verificar duplicados usando análisis temporal y de rangos
 */
async function findExistingEmailMessageByChannel(
  conversationId: string,
  email: any,
  leadId: string
): Promise<{ exists: boolean; messageId?: string; reason?: string }> {
  try {
    console.log(`[EMAIL_SYNC] 🔍 Análisis temporal de mensajes con delivery.channel=email...`);
    
    // Buscar TODOS los mensajes ENVIADOS del canal email para esta conversación (últimos 30 días)
    // Usar consulta más robusta que maneje casos donde custom_data puede no ser JSON válido
    const { data: emailMessages, error } = await supabaseAdmin
      .from('messages')
      .select('id, custom_data, created_at, role, content')
      .eq('conversation_id', conversationId)
      .eq('lead_id', leadId)
      .not('custom_data', 'is', null) // Excluir registros con custom_data null
      .gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()) // Últimos 30 días
      .order('created_at', { ascending: true }) // Ordenar por tiempo ascendente
      .limit(100); // Aumentar límite para filtrar después
      
    if (error) {
      console.error('[EMAIL_SYNC] Error al buscar mensajes para análisis temporal:', error);
      return { exists: false };
    }
    
    if (!emailMessages || emailMessages.length === 0) {
      console.log('[EMAIL_SYNC] ✅ No hay mensajes previos en la conversación');
      return { exists: false };
    }
    
    // Filtrar manualmente los mensajes de email enviados para evitar errores de JSON en PostgreSQL
    const emailSentMessages = emailMessages.filter(msg => {
      try {
        const customData = msg.custom_data;
        
        // Verificar que custom_data sea un objeto válido
        if (!customData || typeof customData !== 'object') {
          return false;
        }
        
        // Verificar que tenga estructura de email enviado
        const isEmailChannel = customData.delivery?.channel === 'email' || 
                              customData.channel === 'email';
        const isSentStatus = customData.status === 'sent' || 
                            customData.delivery?.success === true;
        
        return isEmailChannel && isSentStatus;
      } catch (error) {
        console.warn(`[EMAIL_SYNC] Error parsing custom_data for message ${msg.id}:`, error);
        return false;
      }
    });
    
    if (emailSentMessages.length === 0) {
      console.log('[EMAIL_SYNC] ✅ No hay mensajes enviados previos con delivery.channel=email');
      return { exists: false };
    }
    
    console.log(`[EMAIL_SYNC] 📧 Encontrados ${emailSentMessages.length} mensajes ENVIADOS para análisis temporal (de ${emailMessages.length} mensajes totales)`);
    
    // Preparar datos del email actual
    const currentSubject = email.subject ? fixTextEncoding(email.subject).toLowerCase().trim() : '';
    const currentTo = email.to ? email.to.toLowerCase().trim() : '';
    const currentDate = email.date ? new Date(email.date) : new Date();
    const currentEmailId = extractValidEmailId(email);
    
    console.log(`[EMAIL_SYNC] 📊 Email actual:`, {
      subject: currentSubject,
      to: currentTo,
      date: currentDate.toISOString(),
      emailId: currentEmailId
    });
    
    // Crear array de mensajes existentes con datos normalizados
    const existingMessages = emailSentMessages.map(msg => {
      const customData = msg.custom_data || {};
      const deliveryDetails = customData.delivery?.details || {};
      
      return {
        id: msg.id,
        subject: (deliveryDetails.subject || customData.subject || '').toLowerCase().trim(),
        recipient: (deliveryDetails.recipient || '').toLowerCase().trim(),
        timestamp: deliveryDetails.timestamp ? new Date(deliveryDetails.timestamp) : new Date(msg.created_at),
        emailId: customData.email_id || deliveryDetails.api_messageId || deliveryDetails.external_message_id || customData.delivery?.external_message_id,
        createdAt: new Date(msg.created_at)
      };
    }).sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime()); // Ordenar por timestamp
    
    console.log(`[EMAIL_SYNC] 📈 Mensajes existentes ordenados por timestamp:`);
    existingMessages.forEach((msg, index) => {
      console.log(`[EMAIL_SYNC] ${index + 1}. ${msg.timestamp.toISOString()} - "${msg.subject}" -> ${msg.recipient}`);
    });
    
    // 1. VERIFICACIÓN EXACTA: email_id, subject+recipient, timestamp exacto
    for (const existing of existingMessages) {
      // Verificación por email_id
      if (currentEmailId && existing.emailId && currentEmailId === existing.emailId) {
        console.log(`[EMAIL_SYNC] ✅ DUPLICADO EXACTO por email_id: ${existing.id}`);
        return {
          exists: true,
          messageId: existing.id,
          reason: `Duplicado exacto por email_id: "${currentEmailId}"`
        };
      }
      
      // Verificación por subject + recipient + timestamp cercano (dentro de 5 minutos)
      if (currentSubject && existing.subject && currentSubject === existing.subject &&
          currentTo && existing.recipient && currentTo === existing.recipient) {
        
        const timeDiff = Math.abs(currentDate.getTime() - existing.timestamp.getTime());
        const fiveMinutes = 5 * 60 * 1000;
        
        if (timeDiff <= fiveMinutes) {
          console.log(`[EMAIL_SYNC] ✅ DUPLICADO EXACTO por subject+recipient+timestamp: ${existing.id}`);
          console.log(`[EMAIL_SYNC] - Subject: "${currentSubject}"`);
          console.log(`[EMAIL_SYNC] - Recipient: "${currentTo}"`);
          console.log(`[EMAIL_SYNC] - Time diff: ${Math.round(timeDiff/1000)} segundos`);
          
          return {
            exists: true,
            messageId: existing.id,
            reason: `Duplicado exacto: mismo subject, recipient y timestamp (${Math.round(timeDiff/1000)}s)`
          };
        }
      }
    }
    
    // 2. ANÁLISIS TEMPORAL POR RANGOS - Solo si hay al menos 2 mensajes con el mismo subject
    if (currentSubject) {
      const sameSubjectMessages = existingMessages.filter(msg => msg.subject === currentSubject);
      
      if (sameSubjectMessages.length >= 2) {
        console.log(`[EMAIL_SYNC] 🧮 Análisis de rangos temporales: ${sameSubjectMessages.length} mensajes con subject "${currentSubject}"`);
        
        // Ordenar por timestamp
        sameSubjectMessages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
        
        console.log(`[EMAIL_SYNC] 📅 Secuencia temporal para subject "${currentSubject}":`);
        sameSubjectMessages.forEach((msg, index) => {
          console.log(`[EMAIL_SYNC] ${index + 1}. ${msg.timestamp.toISOString()} -> ${msg.recipient} (ID: ${msg.id})`);
        });
        
        // Verificar si el email actual encaja en algún rango temporal existente
        for (let i = 0; i < sameSubjectMessages.length - 1; i++) {
          const msg1 = sameSubjectMessages[i];
          const msg2 = sameSubjectMessages[i + 1];
          
          // Si el timestamp del email actual está entre dos mensajes existentes
          if (currentDate.getTime() > msg1.timestamp.getTime() && 
              currentDate.getTime() < msg2.timestamp.getTime()) {
            
            // Calcular si la diferencia temporal es consistente
            const gap1 = currentDate.getTime() - msg1.timestamp.getTime();
            const gap2 = msg2.timestamp.getTime() - currentDate.getTime();
            const totalGap = msg2.timestamp.getTime() - msg1.timestamp.getTime();
            
            // Si los gaps son razonables (el email actual divide el rango de manera lógica)
            if (gap1 > 1000 && gap2 > 1000 && totalGap < 24 * 60 * 60 * 1000) { // Máximo 24 horas entre extremos
              console.log(`[EMAIL_SYNC] 🔍 Email actual encaja en rango temporal entre mensajes existentes`);
              console.log(`[EMAIL_SYNC] - Anterior: ${msg1.timestamp.toISOString()} (${Math.round(gap1/1000/60)} min antes)`);
              console.log(`[EMAIL_SYNC] - Actual: ${currentDate.toISOString()}`);
              console.log(`[EMAIL_SYNC] - Siguiente: ${msg2.timestamp.toISOString()} (${Math.round(gap2/1000/60)} min después)`);
              
              // Verificar si el recipient también coincide con alguno de los mensajes del rango
              if (currentTo && (msg1.recipient === currentTo || msg2.recipient === currentTo)) {
                const matchingMsg = msg1.recipient === currentTo ? msg1 : msg2;
                console.log(`[EMAIL_SYNC] ✅ DUPLICADO POR RANGO TEMPORAL: ${matchingMsg.id}`);
                
                return {
                  exists: true,
                  messageId: matchingMsg.id,
                  reason: `Duplicado por rango temporal: mismo subject "${currentSubject}" y recipient "${currentTo}" en secuencia temporal`
                };
              }
            }
          }
        }
        
        // Verificar si está muy cerca del primer o último mensaje de la secuencia
        const firstMsg = sameSubjectMessages[0];
        const lastMsg = sameSubjectMessages[sameSubjectMessages.length - 1];
        
        // Muy cerca del primer mensaje (antes)
        const diffWithFirst = Math.abs(currentDate.getTime() - firstMsg.timestamp.getTime());
        if (diffWithFirst < 30 * 60 * 1000 && currentTo === firstMsg.recipient) { // 30 minutos
          console.log(`[EMAIL_SYNC] ✅ DUPLICADO CERCA DEL PRIMER MENSAJE: ${firstMsg.id}`);
          return {
            exists: true,
            messageId: firstMsg.id,
            reason: `Duplicado temporal: muy cerca del primer mensaje (${Math.round(diffWithFirst/1000/60)} min)`
          };
        }
        
        // Muy cerca del último mensaje (después)
        const diffWithLast = Math.abs(currentDate.getTime() - lastMsg.timestamp.getTime());
        if (diffWithLast < 30 * 60 * 1000 && currentTo === lastMsg.recipient) { // 30 minutos
          console.log(`[EMAIL_SYNC] ✅ DUPLICADO CERCA DEL ÚLTIMO MENSAJE: ${lastMsg.id}`);
          return {
            exists: true,
            messageId: lastMsg.id,
            reason: `Duplicado temporal: muy cerca del último mensaje (${Math.round(diffWithLast/1000/60)} min)`
          };
        }
      }
    }
    
    // 3. VERIFICACIÓN POR RECIPIENT Y PROXIMIDAD TEMPORAL (sin subject)
    if (currentTo) {
      const sameRecipientMessages = existingMessages.filter(msg => msg.recipient === currentTo);
      
      if (sameRecipientMessages.length >= 1) {
        console.log(`[EMAIL_SYNC] 🎯 Verificando ${sameRecipientMessages.length} mensajes al mismo recipient: ${currentTo}`);
        
        for (const msg of sameRecipientMessages) {
          const timeDiff = Math.abs(currentDate.getTime() - msg.timestamp.getTime());
          const oneHour = 60 * 60 * 1000;
          
          // Si es al mismo recipient y muy cerca en el tiempo
          if (timeDiff < oneHour) {
            console.log(`[EMAIL_SYNC] ✅ DUPLICADO POR RECIPIENT+TIEMPO: ${msg.id}`);
            console.log(`[EMAIL_SYNC] - Recipient: "${currentTo}"`);
            console.log(`[EMAIL_SYNC] - Time diff: ${Math.round(timeDiff/1000/60)} minutos`);
            
            return {
              exists: true,
              messageId: msg.id,
              reason: `Duplicado por recipient y proximidad temporal: "${currentTo}" (${Math.round(timeDiff/1000/60)} min)`
            };
          }
        }
      }
    }
    
    console.log('[EMAIL_SYNC] ✅ Análisis temporal completado - NO es duplicado');
    return { exists: false };
    
  } catch (error) {
    console.error('[EMAIL_SYNC] Error en análisis temporal:', error);
    return { exists: false };
  }
}

/**
 * Función para agregar mensaje enviado a la conversación
 */
async function addSentMessageToConversation(
  conversationId: string, 
  email: any, 
  leadId: string, 
  siteId: string
): Promise<string | null> {
  try {
    console.log(`[EMAIL_SYNC] 📧 Verificando mensaje enviado en conversación: ${conversationId}`);
    
    // VERIFICACIÓN COMPLETA usando el servicio especializado de deduplicación
    const duplicationCheck = await SentEmailDuplicationService.validateSentEmailForDuplication(
      email,
      conversationId,
      leadId
    );

         if (duplicationCheck.isDuplicate) {
       console.log(`[EMAIL_SYNC] ✅ DUPLICADO ENCONTRADO: ${duplicationCheck.reason}`);
       console.log(`[EMAIL_SYNC] ✅ ID del mensaje existente: ${duplicationCheck.existingId}`);
       console.log(`[EMAIL_SYNC] ✅ ID estándar usado: ${duplicationCheck.standardId}`);
       return duplicationCheck.existingId!;
     }
     
     // Extraer el ID estándar para uso posterior (crear mensaje)
     const standardEmailId = duplicationCheck.standardId;
     console.log(`[EMAIL_SYNC] 🆔 ID estándar para nuevo mensaje: "${standardEmailId}"`);
     
     // 3. Continuar con extracción de contenido solo si NO es duplicado
    console.log(`[EMAIL_SYNC] 🔧 Extrayendo contenido del email...`);
    
    let messageContent = '';
    let extractionSuccessful = false;
    
    try {
      // Usar EmailTextExtractorService con la configuración que SÍ funciona
      const optimizedEmail = EmailTextExtractorService.extractEmailText(email, {
        maxTextLength: 2000, // Suficiente texto para emails enviados
        removeSignatures: false, // Mantener firma para emails enviados (contexto importante)
        removeQuotedText: true,  // Remover texto citado de respuestas anteriores
        removeHeaders: true,     // Remover headers técnicos
        removeLegalDisclaimer: true // Remover disclaimers legales
      });
      
      console.log(`[EMAIL_SYNC] 📊 Resultado de EmailTextExtractor:`, {
        originalLength: optimizedEmail.originalLength,
        extractedLength: optimizedEmail.textLength,
        compressionRatio: `${(optimizedEmail.compressionRatio * 100).toFixed(1)}%`,
        hasContent: !!optimizedEmail.extractedText && optimizedEmail.extractedText.trim().length > 0
      });
      
      // Verificar si el contenido extraído es válido y útil
      if (optimizedEmail.extractedText && 
          optimizedEmail.extractedText.trim() && 
          optimizedEmail.extractedText !== 'Error al extraer texto del email' &&
          optimizedEmail.extractedText.trim().length > 10) { // Mínimo 10 caracteres para contenido útil
        messageContent = fixTextEncoding(optimizedEmail.extractedText.trim());
        extractionSuccessful = true;
        console.log(`[EMAIL_SYNC] ✅ Contenido extraído y corregido exitosamente: ${messageContent.length} caracteres`);
      } else {
        console.log(`[EMAIL_SYNC] ⚠️ EmailTextExtractor no devolvió contenido válido`);
      }
    } catch (extractorError) {
      console.log(`[EMAIL_SYNC] 🔧 EmailTextExtractor falló, intentando fallback manual...`);
      console.error(`[EMAIL_SYNC] Error del extractor:`, extractorError);
    }
    
    // Si EmailTextExtractor falló, intentar fallback manual más estricto
    // PRIORITY: Prefer text over HTML when both are available (text is cleaner and shorter for AI)
    if (!extractionSuccessful) {
      let fallbackContent = '';
      
      // 1. Intentar con email.text primero
      if (email.text && typeof email.text === 'string' && email.text.trim()) {
        fallbackContent = email.text.trim();
        console.log(`[EMAIL_SYNC] 📝 Usando email.text: ${fallbackContent.length} caracteres`);
      }
      // 2. Intentar con email.body (string directo)
      else if (email.body && typeof email.body === 'string' && email.body.trim()) {
        fallbackContent = email.body.trim();
        console.log(`[EMAIL_SYNC] 📝 Usando email.body (string): ${fallbackContent.length} caracteres`);
      }
      // 3. Verificar si body es un objeto con propiedades anidadas (priorizar text sobre html)
      else if (email.body && typeof email.body === 'object') {
        console.log(`[EMAIL_SYNC] 🔍 Analizando email.body como objeto...`);
        
        if (email.body.text && typeof email.body.text === 'string' && email.body.text.trim()) {
          fallbackContent = email.body.text.trim();
          console.log(`[EMAIL_SYNC] 📝 Usando email.body.text: ${fallbackContent.length} caracteres`);
        } else if (email.body.html && typeof email.body.html === 'string' && email.body.html.trim()) {
          fallbackContent = cleanHtmlContent(email.body.html);
          console.log(`[EMAIL_SYNC] 📝 Usando email.body.html (limpieza comprehensiva): ${fallbackContent.length} caracteres`);
        }
      }
      // 4. Solo como último recurso, intentar con email.html
      else if (email.html && typeof email.html === 'string' && email.html.trim()) {
        fallbackContent = cleanHtmlContent(email.html);
        console.log(`[EMAIL_SYNC] 📝 Usando email.html (limpieza comprehensiva): ${fallbackContent.length} caracteres`);
      }
      
      // Validar que el contenido fallback sea útil (mínimo 10 caracteres)
      if (fallbackContent && fallbackContent.length >= 10) {
        messageContent = fixTextEncoding(fallbackContent);
        extractionSuccessful = true;
        console.log(`[EMAIL_SYNC] ✅ Fallback manual exitoso y corregido: ${messageContent.length} caracteres`);
      }
    }
    
    // Si no se pudo extraer contenido válido, NO crear el mensaje
    if (!extractionSuccessful || !messageContent || messageContent.length < 10) {
      console.log(`[EMAIL_SYNC] ❌ No se pudo extraer contenido válido del email. NO se creará mensaje para evitar ruido.`);
      console.log(`[EMAIL_SYNC] 🔍 Email debug info:`, {
        hasSubject: !!email.subject,
        hasBody: !!email.body,
        hasText: !!email.text,
        hasHtml: !!email.html,
        extractedLength: messageContent.length,
        to: email.to,
        from: email.from,
        emailId: email.id
      });
      return null;
    }
    
    // 4. Verificar por contenido extraído para detectar duplicados más precisamente
    if (email.subject && messageContent) {
      console.log(`[EMAIL_SYNC] 🔍 Buscando mensaje existente por contenido y subject...`);
      
      try {
        const { data: existingByContent } = await supabaseAdmin
          .from('messages')
          .select('id, content, custom_data')
          .eq('conversation_id', conversationId)
          .eq('role', 'team_member') // Solo buscar otros mensajes del team member
          .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
          .limit(10);
          
        if (existingByContent && existingByContent.length > 0) {
          // Normalizar contenido para comparación (incluyendo corrección de codificación)
          const normalizedNewContent = fixTextEncoding(messageContent).toLowerCase().trim().replace(/\s+/g, ' ');
          const emailSubjectNormalized = email.subject ? fixTextEncoding(email.subject).toLowerCase().trim() : '';
          
          for (const existingMsg of existingByContent) {
            const existingContent = existingMsg.content || '';
            const existingSubject = existingMsg.custom_data?.subject || '';
            
            const normalizedExistingContent = existingContent.toLowerCase().trim().replace(/\s+/g, ' ');
            const existingSubjectNormalized = existingSubject.toLowerCase().trim();
            
            // Verificar coincidencias
            const subjectMatch = emailSubjectNormalized === existingSubjectNormalized;
            const exactContentMatch = normalizedNewContent === normalizedExistingContent;
            const highSimilarity = normalizedNewContent.length > 50 && normalizedExistingContent.length > 50 &&
                                   (normalizedNewContent.includes(normalizedExistingContent.substring(0, 100)) ||
                                    normalizedExistingContent.includes(normalizedNewContent.substring(0, 100)));
            
            if (subjectMatch && (exactContentMatch || highSimilarity)) {
              console.log(`[EMAIL_SYNC] ✅ Mensaje duplicado detectado, ID existente: ${existingMsg.id}`);
              return existingMsg.id;
            }
          }
        }
      } catch (contentQueryError) {
        console.error('[EMAIL_SYNC] Error en consulta de verificación por contenido:', contentQueryError);
        // Continuar con el procesamiento en caso de error de consulta
      }
    }
    
    console.log(`[EMAIL_SYNC] ➕ Creando nuevo mensaje con contenido válido (${messageContent.length} caracteres)`);
    
    // Obtener información de la conversación
    const { data: conversation, error: convError } = await supabaseAdmin
      .from('conversations')
      .select('user_id, title')
      .eq('id', conversationId)
      .single();
      
    if (convError || !conversation) {
      console.error('[EMAIL_SYNC] Error al obtener conversación:', convError);
      return null;
    }
    
    // Determinar quién envió el email y el role correcto
    let messageRole = 'system'; // Por defecto sistema
    let messageSenderId = conversation.user_id; // Por defecto el user_id de la conversación
    let teamMemberId: string | null = null;
    
    if (email.from) {
      const teamMember = await findTeamMemberByEmail(email.from, siteId);
      if (teamMember) {
        messageRole = 'team_member';
        messageSenderId = teamMember.id;
        teamMemberId = teamMember.id;
        console.log(`[EMAIL_SYNC] 👤 Email enviado por team member: ${teamMember.id} (${teamMember.name || email.from})`);
      } else {
        console.log(`[EMAIL_SYNC] 🤖 Email enviado por el sistema (no se encontró team member para: ${email.from})`);
      }
    }
    
    console.log(`[EMAIL_SYNC] ➕ Creando nuevo mensaje con contenido válido y fingerprint único`);
    
    // Generar fingerprint estable para el nuevo mensaje
    const stableFingerprint = StableEmailDeduplicationService.generateStableFingerprint(email);
    
    const messageData: any = {
      conversation_id: conversationId,
      content: messageContent, // Usando contenido extraído y validado
      role: messageRole,
      user_id: messageSenderId,
      lead_id: leadId,
              custom_data: {
          status: "sent",
          delivery: {
            channel: "email",
            details: {
              channel: "email",
              recipient: email.to,
              subject: email.subject ? fixTextEncoding(email.subject) : email.subject,
              timestamp: email.date || new Date().toISOString(),
              api_messageId: standardEmailId || email.id || "unknown"
            },
            success: true,
            timestamp: new Date().toISOString()
          },
        follow_up: {
          lead_id: leadId,
          site_id: siteId,
          processed: true,
          processed_at: new Date().toISOString()
        },
        // Mantener campos adicionales para compatibilidad y deduplicación
        email_id: standardEmailId || email.id,
        from: email.from,
        content_extracted: true,
        sync_source: 'email_sync',
        // CAMPOS para deduplicación estable:
        stable_hash: stableFingerprint.stableHash,
        semantic_hash: stableFingerprint.semanticHash,
        time_window: stableFingerprint.timeWindow,
        recipient_normalized: stableFingerprint.recipientNormalized,
        subject_normalized: stableFingerprint.subjectNormalized,
        dedup_version: '2.0'
      }
    };
    
    // Agregar team_member_id si aplica
    if (teamMemberId) {
      messageData.user_id = teamMemberId;
    }
    
    const { data: message, error: messageError } = await supabaseAdmin
      .from('messages')
      .insert([messageData])
      .select()
      .single();
      
    if (messageError) {
      console.error('[EMAIL_SYNC] Error al crear mensaje:', messageError);
      return null;
    }
    
    // Actualizar título de la conversación con el subject si es necesario
    const shouldUpdateTitle = email.subject && email.subject.trim() && (
      !conversation.title || 
      conversation.title.startsWith('Email Conversation -') ||
      conversation.title === 'Nueva conversación'
    );
    
    if (shouldUpdateTitle) {
      const correctedSubject = fixTextEncoding(email.subject.trim());
      console.log(`[EMAIL_SYNC] 📝 Actualizando título de conversación con subject corregido: "${correctedSubject}"`);
      await supabaseAdmin
        .from('conversations')
        .update({ 
          title: correctedSubject,
          last_message_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('id', conversationId);
    } else {
      // Solo actualizar timestamps
      await supabaseAdmin
        .from('conversations')
        .update({ 
          last_message_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('id', conversationId);
    }
    
    // Process calendar attachments if any
    if (email.attachments && email.attachments.length > 0) {
      try {
        const { CalendarAttachmentService } = await import('@/lib/services/calendar/CalendarAttachmentService');
        await CalendarAttachmentService.processAttachments(
          email.attachments,
          siteId,
          undefined, // userId will be resolved inside the service
          leadId,
          conversationId
        );
      } catch (attachmentError) {
        console.error(`[EMAIL_SYNC] ❌ Error processing calendar attachments (sent):`, attachmentError);
      }
    }
    
    console.log(`[EMAIL_SYNC] ✅ Nuevo mensaje enviado creado exitosamente: ${message.id} (role: ${messageRole}, ${messageContent.length} caracteres)`);
    return message.id;
  } catch (error) {
    console.error('[EMAIL_SYNC] Error al agregar mensaje a conversación:', error);
    return null;
  }
}

/**
 * Función para verificar si el lead tiene tareas de prospection en awareness o stages posteriores y crear si es necesario
 */
async function createFirstContactTaskIfNeeded(leadId: string, siteId: string): Promise<string | null> {
  try {
    console.log(`[EMAIL_SYNC] 📋 Verificando tareas de prospection para lead: ${leadId}`);
    
    // Definir stages del customer journey en orden de progresión
    const customerJourneyStages = ['awareness', 'consideration', 'decision', 'action', 'retention'];
    
    // Buscar cualquier tarea existente en awareness o stages posteriores
    const { data: existingTasks, error: tasksError } = await supabaseAdmin
      .from('tasks')
      .select('id, type, stage, status')
      .eq('lead_id', leadId)
      .in('stage', customerJourneyStages)
      .limit(10);
      
    if (tasksError) {
      console.error('[EMAIL_SYNC] Error al buscar tareas existentes:', tasksError);
      return null;
    }
    
    if (existingTasks && existingTasks.length > 0) {
      console.log(`[EMAIL_SYNC] ✅ Lead ya tiene ${existingTasks.length} tareas en customer journey:`, 
        existingTasks.map(t => `${t.type}(${t.stage}:${t.status})`).join(', '));
      
      // Buscar tareas de prospection en estado pending para marcarlas como completed
      const pendingProspectionTasks = existingTasks.filter(t => 
        ['prospection', 'first_contact', 'follow_up'].includes(t.type) && 
        t.status === 'pending'
      );
      
      if (pendingProspectionTasks.length > 0) {
        console.log(`[EMAIL_SYNC] 🔄 Marcando ${pendingProspectionTasks.length} tareas de prospection como completed`);
        
        // Marcar todas las tareas de prospection pending como completed
        for (const task of pendingProspectionTasks) {
          const { error: updateError } = await supabaseAdmin
            .from('tasks')
            .update({ 
              status: 'completed',
              completed_date: new Date().toISOString(),
              notes: `Marked as completed from email sync. Email sent to lead successfully.`,
              updated_at: new Date().toISOString()
            })
            .eq('id', task.id);
            
          if (updateError) {
            console.error(`[EMAIL_SYNC] Error al actualizar tarea ${task.id}:`, updateError);
          } else {
            console.log(`[EMAIL_SYNC] ✅ Tarea ${task.type} (${task.id}) marcada como completed`);
          }
        }
        
        return pendingProspectionTasks[0].id; // Retornar ID de la primera tarea actualizada
      }
      
      console.log(`[EMAIL_SYNC] ℹ️ No hay tareas de prospection en pending, no se crea nueva tarea`);
      return null;
    }
    
    // Obtener información del lead para la tarea
    const { data: lead, error: leadError } = await supabaseAdmin
      .from('leads')
      .select('name, email, user_id, status')
      .eq('id', leadId)
      .single();
      
    if (leadError || !lead) {
      console.error('[EMAIL_SYNC] Error al obtener información del lead para tarea:', leadError);
      return null;
    }
    
    console.log(`[EMAIL_SYNC] ➕ Creando tarea de prospection para lead: ${leadId} (status: ${lead.status})`);
    
    // Determinar el tipo de tarea y stage basado en el status del lead
    let taskType = 'prospection';
    let taskStatus = 'completed'; // Marcada como completada porque ya se envió el email
    let taskStage = 'awareness';
    let taskTitle = `Prospection - ${lead.name || lead.email}`;
    let taskDescription = `Tarea de prospección creada automáticamente al sincronizar email enviado. El lead ha sido contactado exitosamente vía email.`;
    
    // Ajustar tipo de tarea según el contexto
    if (lead.status === 'new') {
      taskType = 'first_contact';
      taskTitle = `First Contact - ${lead.name || lead.email}`;
      taskDescription = `Tarea de primer contacto creada automáticamente. El lead ha sido contactado por primera vez vía email.`;
    } else if (lead.status === 'contacted') {
      taskType = 'follow_up';
      taskTitle = `Follow Up - ${lead.name || lead.email}`;
      taskDescription = `Tarea de seguimiento creada automáticamente. Continuar prospección del lead vía email.`;
    }
    
    const taskData = {
      title: taskTitle,
      description: taskDescription,
      type: taskType,
      status: taskStatus,
      stage: taskStage,
      priority: 1,
      user_id: lead.user_id,
      site_id: siteId,
      lead_id: leadId,
      scheduled_date: new Date().toISOString(),
      completed_date: new Date().toISOString(),
      notes: `Auto-created from email sync. Email sent to lead successfully. Lead status: ${lead.status}`
    };
    
    const task = await createTask(taskData);
    console.log(`[EMAIL_SYNC] ✅ Tarea de ${taskType} creada: ${task.id} para lead status: ${lead.status}`);
    
    return task.id;
  } catch (error) {
    console.error('[EMAIL_SYNC] Error al crear tarea de prospection:', error);
    return null;
  }
}

/**
 * Detecta si un email es parte de un hilo de conversación
 */
function detectEmailThread(email: any): {
  isThread: boolean;
  threadSubject: string;
  replyType?: 'reply' | 'forward';
  inReplyTo?: string;
  references?: string[];
} {
  const subject = email.subject || '';
  const headers = email.headers || {};
  
  // Detectar por subject (Re:, Fwd:, etc.)
  const replyMatch = subject.match(/^(Re|RE|Fwd|FWD|Fw|FW):\s*(.+)/i);
  const isReplyBySubject = !!replyMatch;
  
  // Detectar por headers
  const inReplyTo = headers['in-reply-to'] || headers['In-Reply-To'];
  const references = headers['references'] || headers['References'];
  const referencesArray = references ? references.split(/\s+/).filter(Boolean) : [];
  
  const isReplyByHeaders = !!(inReplyTo || referencesArray.length > 0);
  
  const isThread = isReplyBySubject || isReplyByHeaders;
  
  // Obtener subject limpio (sin Re:, Fwd:)
  const cleanSubject = replyMatch ? replyMatch[2].trim() : subject;
  
  // Determinar tipo de respuesta
  let replyType: 'reply' | 'forward' | undefined;
  if (isReplyBySubject) {
    const prefix = replyMatch![1].toLowerCase();
    if (prefix.startsWith('re')) {
      replyType = 'reply';
    } else if (prefix.startsWith('fw') || prefix.startsWith('fwd')) {
      replyType = 'forward';
    }
  }
  
  console.log(`[EMAIL_SYNC] 🧵 Detección de hilo para "${subject}":`, {
    isThread,
    replyType,
    cleanSubject,
    hasInReplyTo: !!inReplyTo,
    referencesCount: referencesArray.length
  });
  
  return {
    isThread,
    threadSubject: cleanSubject,
    replyType,
    inReplyTo,
    references: referencesArray
  };
}

/**
 * Busca emails relacionados del mismo hilo en la bandeja de entrada
 */
async function fetchRelatedThreadEmails(
  threadSubject: string,
  participantEmail: string,
  siteId: string,
  emailConfig: any,
  sentEmailDate: string
): Promise<any[]> {
  try {
    console.log(`[EMAIL_SYNC] 🔍 Buscando emails relacionados del hilo:`);
    console.log(`[EMAIL_SYNC] - Subject: "${threadSubject}"`);
    console.log(`[EMAIL_SYNC] - Participante: ${participantEmail}`);
    console.log(`[EMAIL_SYNC] - Fecha email enviado: ${sentEmailDate}`);
    
    // Calcular rango de fechas: 30 días antes del email enviado
    const sentDate = new Date(sentEmailDate);
    const searchFromDate = new Date(sentDate.getTime() - (30 * 24 * 60 * 60 * 1000));
    
    console.log(`[EMAIL_SYNC] 📅 Buscando emails desde: ${searchFromDate.toISOString()}`);
    
    // Obtener emails recibidos en el rango de fechas
    const allReceivedEmails = await EmailService.fetchEmails(emailConfig, 50, searchFromDate.toISOString());
    
    console.log(`[EMAIL_SYNC] 📥 Emails recibidos encontrados: ${allReceivedEmails.length}`);
    
    // Filtrar emails relacionados al hilo
    const relatedEmails = allReceivedEmails.filter(email => {
      const emailFrom = email.from?.toLowerCase() || '';
      const emailSubject = email.subject || '';
      
      // Verificar que sea del participante
      const isFromParticipant = emailFrom.includes(participantEmail.toLowerCase());
      
      // Verificar que el subject esté relacionado
      const emailSubjectClean = emailSubject.replace(/^(Re|RE|Fwd|FWD|Fw|FW):\s*/gi, '').trim();
      const isRelatedSubject = emailSubjectClean.toLowerCase() === threadSubject.toLowerCase() ||
                               emailSubject.toLowerCase().includes(threadSubject.toLowerCase()) ||
                               threadSubject.toLowerCase().includes(emailSubjectClean.toLowerCase());
      
      return isFromParticipant && isRelatedSubject;
    });
    
    console.log(`[EMAIL_SYNC] 🧵 Emails relacionados al hilo encontrados: ${relatedEmails.length}`);
    
    relatedEmails.forEach(email => {
      console.log(`[EMAIL_SYNC] - ${email.date}: "${email.subject}" de ${email.from}`);
    });
    
    return relatedEmails;
  } catch (error) {
    console.error('[EMAIL_SYNC] Error buscando emails relacionados:', error);
    return [];
  }
}

/**
 * Procesa y sincroniza emails relacionados del hilo que no han sido procesados
 */
async function syncRelatedThreadEmails(
  relatedEmails: any[],
  siteId: string,
  leadId: string,
  conversationId: string
): Promise<{
  processedCount: number;
  alreadySyncedCount: number;
  messageIds: string[];
}> {
  try {
    console.log(`[EMAIL_SYNC] 🔄 Sincronizando ${relatedEmails.length} emails relacionados del hilo...`);
    
    // Filtrar emails ya procesados
    const { unprocessed: unprocessedEmails, alreadyProcessed } = await SyncedObjectsService.filterUnprocessedEmails(
      relatedEmails,
      siteId,
      'email' // Tipo para emails recibidos
    );
    
    console.log(`[EMAIL_SYNC] 📊 Emails del hilo:`, {
      total: relatedEmails.length,
      nuevos: unprocessedEmails.length,
      yaProcesados: alreadyProcessed.length
    });
    
    const messageIds: string[] = [];
    let processedCount = 0;
    
    // Procesar emails no sincronizados
    for (const email of unprocessedEmails) {
      try {
        console.log(`[EMAIL_SYNC] 📧 Procesando email del hilo: "${email.subject}" de ${email.from}`);
        
        // Intentar mejorar el nombre del lead con información del email recibido
        if (email.from) {
          await updateLeadNameIfBetter(leadId, email, email.from);
        }
        
        // Agregar mensaje recibido a la conversación
        const messageId = await addReceivedMessageToConversation(conversationId, email, leadId, siteId);
        
        if (messageId) {
          messageIds.push(messageId);
          processedCount++;
          
          // Marcar como procesado
          const emailId = email.id || email.messageId || email.uid;
          if (emailId) {
            await SyncedObjectsService.updateObject(emailId, siteId, {
              status: 'processed',
              metadata: {
                conversation_id: conversationId,
                message_id: messageId,
                lead_id: leadId,
                sync_source: 'thread_sync',
                processed_at: new Date().toISOString()
              }
            }, 'email');
          }
          
          console.log(`[EMAIL_SYNC] ✅ Email del hilo sincronizado: ${messageId}`);
        }
      } catch (emailError) {
        console.error(`[EMAIL_SYNC] Error procesando email del hilo:`, emailError);
      }
    }
    
    console.log(`[EMAIL_SYNC] ✅ Sincronización del hilo completada:`, {
      processedCount,
      alreadySyncedCount: alreadyProcessed.length,
      messageIds: messageIds.length
    });
    
    return {
      processedCount,
      alreadySyncedCount: alreadyProcessed.length,
      messageIds
    };
  } catch (error) {
    console.error('[EMAIL_SYNC] Error sincronizando emails del hilo:', error);
    return {
      processedCount: 0,
      alreadySyncedCount: 0,
      messageIds: []
    };
  }
}

/**
 * Agrega un mensaje recibido (del hilo) a la conversación
 */
async function addReceivedMessageToConversation(
  conversationId: string,
  email: any,
  leadId: string,
  siteId: string
): Promise<string | null> {
  try {
    console.log(`[EMAIL_SYNC] 📩 Agregando mensaje recibido del hilo a conversación: ${conversationId}`);
    
    // 1. VALIDACIÓN: Los emails recibidos del hilo usan estructura diferente, usar validación por email_id
    
    // 2. Extraer y validar contenido - Si no hay contenido válido, no crear mensaje
    console.log(`[EMAIL_SYNC] 🔧 Extrayendo contenido del email recibido...`);
    
    let messageContent = '';
    let extractionSuccessful = false;
    
    try {
      // Extraer contenido del email recibido con configuración específica
      const optimizedEmail = EmailTextExtractorService.extractEmailText(email, {
        maxTextLength: 2000,
        removeSignatures: true,    // Remover firmas de emails recibidos
        removeQuotedText: true,    // Remover texto citado
        removeHeaders: true,       // Remover headers
        removeLegalDisclaimer: true
      });
      
      console.log(`[EMAIL_SYNC] 📊 Resultado de EmailTextExtractor (recibido):`, {
        originalLength: optimizedEmail.originalLength,
        extractedLength: optimizedEmail.textLength,
        compressionRatio: `${(optimizedEmail.compressionRatio * 100).toFixed(1)}%`,
        hasContent: !!optimizedEmail.extractedText && optimizedEmail.extractedText.trim().length > 0
      });
      
      // Verificar si el contenido extraído es válido y útil
      if (optimizedEmail.extractedText && 
          optimizedEmail.extractedText.trim() && 
          optimizedEmail.extractedText !== 'Error al extraer texto del email' &&
          optimizedEmail.extractedText.trim().length > 10) { // Mínimo 10 caracteres para contenido útil
        messageContent = fixTextEncoding(optimizedEmail.extractedText.trim());
        extractionSuccessful = true;
        console.log(`[EMAIL_SYNC] ✅ Contenido de email recibido extraído y corregido exitosamente: ${messageContent.length} caracteres`);
      } else {
        console.log(`[EMAIL_SYNC] ⚠️ EmailTextExtractor no devolvió contenido válido para email recibido`);
      }
    } catch (extractorError) {
      console.log(`[EMAIL_SYNC] 🔧 EmailTextExtractor falló para email recibido, intentando fallback...`);
      console.error(`[EMAIL_SYNC] Error del extractor:`, extractorError);
    }
    
    // Si EmailTextExtractor falló, intentar fallback manual más estricto
    // PRIORITY: Prefer text over HTML when both are available (text is cleaner and shorter for AI)
    if (!extractionSuccessful) {
      let fallbackContent = '';
      
      // Intentar extraer contenido con fallbacks (priorizar texto sobre HTML)
      if (email.text && typeof email.text === 'string' && email.text.trim()) {
        fallbackContent = email.text.trim();
      } else if (email.body && typeof email.body === 'string' && email.body.trim()) {
        fallbackContent = email.body.trim();
      } else if (email.body && typeof email.body === 'object') {
        if (email.body.text && typeof email.body.text === 'string' && email.body.text.trim()) {
          fallbackContent = email.body.text.trim();
        } else if (email.body.html && typeof email.body.html === 'string' && email.body.html.trim()) {
          fallbackContent = cleanHtmlContent(email.body.html);
        }
      } else if (email.html && typeof email.html === 'string' && email.html.trim()) {
        fallbackContent = cleanHtmlContent(email.html);
      }
      
      // Validar que el contenido fallback sea útil (mínimo 10 caracteres)
      if (fallbackContent && fallbackContent.length >= 10) {
        messageContent = fixTextEncoding(fallbackContent);
        extractionSuccessful = true;
        console.log(`[EMAIL_SYNC] ✅ Fallback manual exitoso y corregido para email recibido: ${messageContent.length} caracteres`);
      }
    }
    
    // Si no se pudo extraer contenido válido, NO crear el mensaje
    if (!extractionSuccessful || !messageContent || messageContent.length < 10) {
      console.log(`[EMAIL_SYNC] ❌ No se pudo extraer contenido válido del email recibido. NO se creará mensaje para evitar ruido.`);
      console.log(`[EMAIL_SYNC] 🔍 Email recibido debug info:`, {
        hasSubject: !!email.subject,
        hasBody: !!email.body,
        hasText: !!email.text,
        hasHtml: !!email.html,
        extractedLength: messageContent.length,
        from: email.from,
        to: email.to,
        emailId: email.id || email.messageId || email.uid
      });
      return null;
    }
    
    // 2. Verificar si ya existe un mensaje con este email_id
    const emailId = extractValidEmailId(email);
    if (emailId) {
      console.log(`[EMAIL_SYNC] 🔍 Buscando mensaje recibido existente con email_id: ${emailId}`);
      
      const { data: existingMessage } = await supabaseAdmin
        .from('messages')
        .select('id')
        .eq('conversation_id', conversationId)
        .filter('custom_data->>email_id', 'eq', emailId)
        .limit(1);
        
      if (existingMessage && existingMessage.length > 0) {
        console.log(`[EMAIL_SYNC] ✅ Mensaje recibido ya existe: ${existingMessage[0].id}`);
        return existingMessage[0].id;
      }
    } else {
      console.log(`[EMAIL_SYNC] ⚠️ No se pudo extraer un email ID válido para mensaje recibido`);
    }
    
    // 3. Verificar por contenido extraído para detectar duplicados más precisamente
    if (email.subject && messageContent) {
      console.log(`[EMAIL_SYNC] 🔍 Buscando mensaje recibido existente por contenido...`);
      
      const { data: existingByContent } = await supabaseAdmin
        .from('messages')
        .select('id, content, custom_data')
        .eq('conversation_id', conversationId)
        .eq('role', 'team_member') // Solo buscar otros mensajes del team member
        .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
        .limit(10);
        
      if (existingByContent && existingByContent.length > 0) {
        // Normalizar contenido para comparación (incluyendo corrección de codificación)
        const normalizedNewContent = fixTextEncoding(messageContent).toLowerCase().trim().replace(/\s+/g, ' ');
        const emailSubjectNormalized = email.subject ? fixTextEncoding(email.subject).toLowerCase().trim() : '';
        
        for (const existingMsg of existingByContent) {
          const existingContent = existingMsg.content || '';
          const existingSubject = existingMsg.custom_data?.subject || '';
          
          const normalizedExistingContent = existingContent.toLowerCase().trim().replace(/\s+/g, ' ');
          const existingSubjectNormalized = existingSubject.toLowerCase().trim();
          
          // Verificar coincidencias
          const subjectMatch = emailSubjectNormalized === existingSubjectNormalized;
          const exactContentMatch = normalizedNewContent === normalizedExistingContent;
          const highSimilarity = normalizedNewContent.length > 50 && normalizedExistingContent.length > 50 &&
                                 (normalizedNewContent.includes(normalizedExistingContent.substring(0, 100)) ||
                                  normalizedExistingContent.includes(normalizedNewContent.substring(0, 100)));
          
          if (subjectMatch && (exactContentMatch || highSimilarity)) {
            console.log(`[EMAIL_SYNC] ✅ Mensaje duplicado detectado, ID existente: ${existingMsg.id}`);
            return existingMsg.id;
          }
        }
      }
    }
    
    console.log(`[EMAIL_SYNC] ➕ Creando nuevo mensaje recibido con contenido válido (${messageContent.length} caracteres)`);
    
    // Obtener información de la conversación
    const { data: conversation } = await supabaseAdmin
      .from('conversations')
      .select('user_id')
      .eq('id', conversationId)
      .single();
      
    if (!conversation) {
      console.error('[EMAIL_SYNC] No se pudo obtener conversación para mensaje recibido');
      return null;
    }
    
    // Crear mensaje como 'visitor' (mensaje del destinatario/cliente)
    // Los emails recibidos del hilo mantienen estructura simple de custom_data
    const messageData = {
      conversation_id: conversationId,
      content: messageContent, // Usando contenido extraído y validado
      role: 'visitor',  // Email recibido del lead/cliente (roles válidos: visitor, agent, user, system, assistant, team_member)
      user_id: conversation.user_id,
      lead_id: leadId,
      custom_data: {
        type: 'received_email',
        channel: 'email',
        email_id: emailId,
        subject: email.subject ? fixTextEncoding(email.subject) : email.subject,
        from: email.from,
        to: email.to,
        date: email.date,
        content_extracted: true,
        sync_source: 'thread_sync'
      }
    };
    
    const { data: message, error } = await supabaseAdmin
      .from('messages')
      .insert([messageData])
      .select()
      .single();
      
    if (error) {
      console.error('[EMAIL_SYNC] Error creando mensaje recibido del hilo:', error);
      return null;
    }
    
    // Actualizar última actividad de la conversación
    await supabaseAdmin
      .from('conversations')
      .update({ 
        last_message_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', conversationId);
    
    // Process calendar attachments if any
    if (email.attachments && email.attachments.length > 0) {
      try {
        const { CalendarAttachmentService } = await import('@/lib/services/calendar/CalendarAttachmentService');
        await CalendarAttachmentService.processAttachments(
          email.attachments,
          siteId,
          undefined, // userId will be resolved inside the service
          leadId,
          conversationId
        );
      } catch (attachmentError) {
        console.error(`[EMAIL_SYNC] ❌ Error processing calendar attachments (received):`, attachmentError);
      }
    }

    console.log(`[EMAIL_SYNC] ✅ Mensaje recibido del hilo creado exitosamente: ${message.id} (${messageContent.length} caracteres)`);
    return message.id;
  } catch (error) {
    console.error('[EMAIL_SYNC] Error agregando mensaje recibido del hilo:', error);
    return null;
  }
}

/**
 * Función para procesar un email enviado individual
 */
async function processSentEmail(email: any, siteId: string): Promise<{
  success: boolean;
  leadId?: string;
  conversationId?: string;
  messageId?: string;
  taskId?: string;
  isNewLead?: boolean;
  statusUpdated?: boolean;
  nameUpdated?: boolean;
  assignedToTeamMember?: boolean;
  threadSync?: {
    processedCount: number;
    alreadySyncedCount: number;
    messageIds: string[];
  };
  error?: string;
  skipped?: boolean;
}> {
  try {
    console.log(`[EMAIL_SYNC] 🔄 Procesando email enviado a: ${email.to}`);
    
    const emailId = extractValidEmailId(email);
    
    const toEmail = email.to;
    if (!toEmail || !toEmail.includes('@')) {
      // Marcar como error usando el servicio especializado
      await SentEmailDuplicationService.markSentEmailAsError(email, siteId, 'Email destinatario inválido');
      
      return {
        success: false,
        error: 'Email destinatario inválido'
      };
    }

    // Validar que no sea un email enviado a dominios internos de Uncodie
    const internalValidation = validateEmailNotToInternalDomains(email);
    if (!internalValidation.isValid) {
      console.log(`[EMAIL_SYNC] 🚫 Email enviado a dominio interno detectado: ${email.to} - ${internalValidation.reason}`);
      
      // Marcar como skipped usando el servicio especializado
      await SentEmailDuplicationService.markSentEmailAsError(email, siteId, internalValidation.reason || 'Email enviado a dominio interno', true);
      
      return {
        success: false,
        error: internalValidation.reason,
        skipped: true
      };
    }
    
    // 1. Buscar o crear lead
    let leadId = await findLeadByEmail(toEmail, siteId);
    let isNewLead = false;
    
    if (!leadId) {
      leadId = await createLeadFromSentEmail(toEmail, siteId, email.subject || 'No Subject', email);
      isNewLead = true;
    }
    
    if (!leadId) {
      return {
        success: false,
        error: 'No se pudo obtener o crear lead'
      };
    }
    
    // 1.5. Intentar mejorar el nombre del lead si encontramos uno mejor en el email
    const nameUpdated = await updateLeadNameIfBetter(leadId, email, toEmail);
    
    // 2. Verificar si el email fue enviado por un team member y asignar el lead si es necesario
    let assignedToTeamMember = false;
    if (email.from) {
      const teamMember = await findTeamMemberByEmail(email.from, siteId);
      if (teamMember) {
        const assigned = await assignLeadToTeamMember(leadId, teamMember.id, teamMember.name);
        if (assigned) {
          assignedToTeamMember = true;
          console.log(`[EMAIL_SYNC] ✅ Lead ${leadId} asignado al team member: ${teamMember.id} (${teamMember.name || email.from})`);
        }
      }
    }
    
    // 3. Actualizar status del lead si es necesario
    const statusUpdated = await updateLeadStatusIfNeeded(leadId);
    
    // 4. Buscar o crear conversación de email
    const conversationId = await findOrCreateEmailConversation(leadId, siteId, email.subject);
    
    if (!conversationId) {
      return {
        success: false,
        leadId,
        isNewLead,
        statusUpdated,
        assignedToTeamMember,
        error: 'No se pudo obtener o crear conversación'
      };
    }
    
    // 5. Agregar mensaje enviado a la conversación
    const messageId = await addSentMessageToConversation(conversationId, email, leadId, siteId);
    
    // Si no se pudo crear el mensaje debido a contenido inválido, registrarlo pero continuar con el procesamiento
    if (!messageId) {
      console.log(`[EMAIL_SYNC] ⚠️ No se pudo crear mensaje debido a contenido insuficiente, pero continuando con procesamiento del lead y conversación`);
    }
    
    // 6. Detectar y sincronizar hilo de conversación si es necesario
    let threadSyncResult: {
      processedCount: number;
      alreadySyncedCount: number;
      messageIds: string[];
    } | null = null;
    
    const threadInfo = detectEmailThread(email);
    if (threadInfo.isThread) {
      console.log(`[EMAIL_SYNC] 🧵 Email detectado como parte de un hilo: "${threadInfo.threadSubject}" (${threadInfo.replyType})`);
      
      try {
        // Obtener configuración de email para buscar emails relacionados
        const emailConfig = await EmailConfigService.getEmailConfig(siteId);
        
        // Buscar emails relacionados del destinatario en el hilo
        const relatedEmails = await fetchRelatedThreadEmails(
          threadInfo.threadSubject,
          email.to, // Email del destinatario
          siteId,
          emailConfig,
          email.date || new Date().toISOString()
        );
        
        if (relatedEmails.length > 0) {
          console.log(`[EMAIL_SYNC] 🔄 Sincronizando ${relatedEmails.length} emails relacionados del hilo...`);
          
          // Sincronizar emails relacionados del hilo
          threadSyncResult = await syncRelatedThreadEmails(
            relatedEmails,
            siteId,
            leadId,
            conversationId
          );
          
          console.log(`[EMAIL_SYNC] ✅ Sincronización del hilo completada:`, threadSyncResult);
        } else {
          console.log(`[EMAIL_SYNC] ℹ️ No se encontraron emails relacionados del hilo para sincronizar`);
        }
      } catch (threadError) {
        console.error('[EMAIL_SYNC] Error sincronizando hilo:', threadError);
      }
    } else {
      console.log(`[EMAIL_SYNC] ℹ️ Email no es parte de un hilo existente`);
    }
    
    // 7. Crear tarea de first contact si es necesario
    const taskId = await createFirstContactTaskIfNeeded(leadId, siteId);
    
    // 8. Marcar email como procesado exitosamente usando el servicio especializado
    const marked = await SentEmailDuplicationService.markSentEmailAsProcessed(email, siteId, {
      lead_id: leadId,
      conversation_id: conversationId,
      message_id: messageId,
      message_created: !!messageId, // Indicar si se creó el mensaje o no
      task_id: taskId,
      subject: email.subject,
      to: email.to,
      from: email.from,
      is_new_lead: isNewLead,
      status_updated: statusUpdated,
      name_updated: nameUpdated,
      thread_sync_result: threadSyncResult,
      no_content_extracted: !messageId, // Indicar si falló por falta de contenido
    });
    
    if (marked) {
      if (messageId) {
        console.log(`[EMAIL_SYNC] ✅ Email marcado como procesado exitosamente con mensaje creado`);
      } else {
        console.log(`[EMAIL_SYNC] ✅ Email marcado como procesado (sin mensaje por falta de contenido)`);
      }
    } else {
      console.log(`[EMAIL_SYNC] ⚠️ No se pudo marcar email como procesado en SentEmailDuplicationService`);
    }
    
    return {
      success: true,
      leadId,
      conversationId,
      messageId: messageId || undefined,
      taskId: taskId || undefined,
      isNewLead,
      statusUpdated,
      nameUpdated,
      assignedToTeamMember,
      threadSync: threadSyncResult || undefined
    };
    
  } catch (error) {
    console.error('[EMAIL_SYNC] Error al procesar email enviado:', error);
    
    // Marcar como error usando el servicio especializado
    await SentEmailDuplicationService.markSentEmailAsError(
      email, 
      siteId, 
      error instanceof Error ? error.message : 'Error desconocido'
    );
    
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Error desconocido'
    };
  }
}

/**
 * Función para asignar un lead a un team member
 */
async function assignLeadToTeamMember(leadId: string, teamMemberId: string, teamMemberName?: string): Promise<boolean> {
  try {
    console.log(`[EMAIL_SYNC] 👤 Asignando lead ${leadId} al team member: ${teamMemberId} (${teamMemberName || 'sin nombre'})`);
    
    const { error } = await supabaseAdmin
      .from('leads')
      .update({ 
        assignee_id: teamMemberId,
        updated_at: new Date().toISOString()
      })
      .eq('id', leadId);
      
    if (error) {
      console.error('[EMAIL_SYNC] Error al asignar lead al team member:', error);
      return false;
    }
    
    console.log(`[EMAIL_SYNC] ✅ Lead ${leadId} asignado exitosamente al team member: ${teamMemberId}`);
    return true;
  } catch (error) {
    console.error('[EMAIL_SYNC] Error al asignar lead al team member:', error);
    return false;
  }
}

/**
 * Función para buscar un team member por email en el sitio
 */
async function findTeamMemberByEmail(email: string, siteId: string): Promise<{id: string, name?: string} | null> {
  try {
    console.log(`[EMAIL_SYNC] 🔍 Buscando team member por email: ${email} en sitio: ${siteId}`);
    
    // 1. Buscar en site_members por email
    const { data: siteMembers, error: siteMembersError } = await supabaseAdmin
      .from('site_members')
      .select('user_id, email, name')
      .eq('site_id', siteId)
      .eq('email', email.toLowerCase().trim())
      .eq('status', 'active')
      .limit(1);
    
    if (siteMembersError) {
      console.error('[EMAIL_SYNC] Error al buscar en site_members:', siteMembersError);
    } else if (siteMembers && siteMembers.length > 0) {
      const member = siteMembers[0];
      console.log(`[EMAIL_SYNC] ✅ Team member encontrado en site_members: ${member.user_id}`);
      return {
        id: member.user_id,
        name: member.name || undefined
      };
    }
    
    // 2. Buscar en site_ownership por email del usuario auth
    const { data: siteOwners, error: siteOwnersError } = await supabaseAdmin
      .from('site_ownership')
      .select('user_id')
      .eq('site_id', siteId);
    
    if (siteOwnersError) {
      console.error('[EMAIL_SYNC] Error al buscar en site_ownership:', siteOwnersError);
    } else if (siteOwners && siteOwners.length > 0) {
      // Verificar el email de cada owner
      for (const owner of siteOwners) {
        try {
          const { data: userData, error: userError } = await supabaseAdmin.auth.admin.getUserById(owner.user_id);
          if (!userError && userData.user && userData.user.email && 
              userData.user.email.toLowerCase().trim() === email.toLowerCase().trim()) {
            console.log(`[EMAIL_SYNC] ✅ Team member (owner) encontrado: ${owner.user_id}`);
            return {
              id: owner.user_id,
              name: userData.user.user_metadata?.name || userData.user.user_metadata?.full_name || undefined
            };
          }
        } catch (ownerCheckError) {
          console.warn(`[EMAIL_SYNC] Error verificando owner ${owner.user_id}:`, ownerCheckError);
        }
      }
    }
    
    console.log(`[EMAIL_SYNC] ⚠️ No se encontró team member con email: ${email}`);
    return null;
  } catch (error) {
    console.error('[EMAIL_SYNC] Error al buscar team member por email:', error);
    return null;
  }
}

/**
 * Función para corregir problemas de codificación de caracteres en texto de email
 * Ahora más simple - delegamos principalmente al EmailTextExtractorService
 */
function fixTextEncoding(text: string): string {
  if (!text || typeof text !== 'string') {
    return text;
  }
  
  try {
    let fixedText = text;
    
    // Correcciones básicas más comunes de UTF-8 mal interpretado como ISO-8859-1
    fixedText = fixedText
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
      // Limpiar espacios múltiples y caracteres de control
      .replace(/\s+/g, ' ')
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
      .trim();
    
    return fixedText;
  } catch (error) {
    console.warn('[EMAIL_SYNC] Error al corregir codificación de texto:', error);
    return text; // Retornar texto original si hay error
  }
}

/**
 * Función para extraer el nombre de un contacto desde información de email
 */
function extractContactName(email: any, emailAddress?: string): string | null {
  try {
    // 1. Intentar extraer nombre del campo "from" con formato "Nombre <email@domain.com>"
    if (email.from && typeof email.from === 'string') {
      const fromField = fixTextEncoding(email.from.trim());
      
      // Formato: "Juan Pérez <juan@empresa.com>"
      const nameMatch = fromField.match(/^(.+?)\s*<([^>]+)>$/);
      if (nameMatch) {
        const extractedName = nameMatch[1].trim();
        // Verificar que no sea solo un email
        if (extractedName && !extractedName.includes('@') && extractedName.length > 1) {
          console.log(`[EMAIL_SYNC] 👤 Nombre extraído del campo 'from': "${extractedName}"`);
          return extractedName;
        }
      }
      
      // Formato: "Juan Pérez" (sin <email>)
      if (fromField && !fromField.includes('@') && !fromField.includes('<') && fromField.length > 1) {
        console.log(`[EMAIL_SYNC] 👤 Nombre extraído directamente del campo 'from': "${fromField}"`);
        return fromField;
      }
    }
    
    // 2. Intentar extraer desde headers adicionales
    if (email.headers && typeof email.headers === 'object') {
      // Header "Reply-To" a veces contiene nombre
      const replyTo = email.headers['reply-to'] || email.headers['Reply-To'];
      if (replyTo && typeof replyTo === 'string') {
        const replyToField = fixTextEncoding(replyTo.trim());
        const nameMatch = replyToField.match(/^(.+?)\s*<([^>]+)>$/);
        if (nameMatch) {
          const extractedName = nameMatch[1].trim();
          if (extractedName && !extractedName.includes('@') && extractedName.length > 1) {
            console.log(`[EMAIL_SYNC] 👤 Nombre extraído del campo 'Reply-To': "${extractedName}"`);
            return extractedName;
          }
        }
      }
      
      // Header "Sender" como alternativa
      const sender = email.headers['sender'] || email.headers['Sender'];
      if (sender && typeof sender === 'string') {
        const senderField = fixTextEncoding(sender.trim());
        const nameMatch = senderField.match(/^(.+?)\s*<([^>]+)>$/);
        if (nameMatch) {
          const extractedName = nameMatch[1].trim();
          if (extractedName && !extractedName.includes('@') && extractedName.length > 1) {
            console.log(`[EMAIL_SYNC] 👤 Nombre extraído del campo 'Sender': "${extractedName}"`);
            return extractedName;
          }
        }
      }
    }
    
    // 3. Intentar extraer nombre del propio campo email si se proporciona
    const targetEmail = emailAddress || email.to || email.from;
    if (targetEmail && typeof targetEmail === 'string') {
      // Buscar formato "Nombre <email@domain.com>" en el email objetivo
      const emailMatch = targetEmail.match(/^(.+?)\s*<([^>]+)>$/);
      if (emailMatch) {
        const extractedName = emailMatch[1].trim();
        if (extractedName && !extractedName.includes('@') && extractedName.length > 1) {
          console.log(`[EMAIL_SYNC] 👤 Nombre extraído del email objetivo: "${extractedName}"`);
          return fixTextEncoding(extractedName);
        }
      }
      
      // 4. Como último recurso, generar nombre inteligente desde la dirección de email
      const emailOnly = emailMatch ? emailMatch[2] : targetEmail;
      if (emailOnly && emailOnly.includes('@')) {
        const [localPart] = emailOnly.split('@');
        
        // Mejorar la extracción del nombre desde la parte local del email
        let nameFromEmail = localPart
          .replace(/[._+]/g, ' ')           // Reemplazar puntos, guiones y + por espacios
          .replace(/\d+/g, '')             // Remover números
          .replace(/\s+/g, ' ')            // Múltiples espacios a uno
          .trim();
        
        // Capitalizar palabras apropiadamente
        if (nameFromEmail && nameFromEmail.length > 1) {
          nameFromEmail = nameFromEmail
            .split(' ')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join(' ');
          
          // Solo retornar si parece un nombre real (más de 2 caracteres, no solo números/símbolos)
          if (nameFromEmail.length > 2 && /[a-zA-Z]/.test(nameFromEmail)) {
            console.log(`[EMAIL_SYNC] 👤 Nombre generado desde email: "${nameFromEmail}"`);
            return nameFromEmail;
          }
        }
      }
    }
    
    console.log(`[EMAIL_SYNC] ⚠️ No se pudo extraer nombre del contacto`);
    return null;
  } catch (error) {
    console.warn('[EMAIL_SYNC] Error al extraer nombre del contacto:', error);
    return null;
  }
}



/**
 * Función para actualizar el nombre de un lead si encontramos uno mejor
 */
async function updateLeadNameIfBetter(leadId: string, emailObject: any, currentEmail: string): Promise<boolean> {
  try {
    console.log(`[EMAIL_SYNC] 🏷️ Verificando si se puede mejorar el nombre del lead: ${leadId}`);
    
    // Obtener información actual del lead
    const { data: lead, error: leadError } = await supabaseAdmin
      .from('leads')
      .select('name, email')
      .eq('id', leadId)
      .single();
      
    if (leadError || !lead) {
      console.error('[EMAIL_SYNC] Error al obtener lead para actualizar nombre:', leadError);
      return false;
    }
    
    const currentName = lead.name || '';
    console.log(`[EMAIL_SYNC] 📝 Nombre actual del lead: "${currentName}"`);
    
    // Verificar si el nombre actual parece generado automáticamente o es genérico
    const isGenericName = !currentName || 
                         currentName.startsWith('Contact from Email') ||
                         currentName.startsWith('Contact from') ||
                         currentName.length < 3 ||
                         currentName === currentEmail.split('@')[0];
    
    // Extraer nombre del email
    const extractedName = extractContactName(emailObject, currentEmail);
    
    if (extractedName && extractedName.length > 2) {
      // Si el nombre actual es genérico, o si el nuevo nombre es significativamente mejor
      const shouldUpdate = isGenericName || 
                          (extractedName.length > currentName.length && 
                           extractedName.includes(' ') && 
                           !currentName.includes(' '));
      
      if (shouldUpdate) {
        console.log(`[EMAIL_SYNC] ✨ Actualizando nombre del lead de "${currentName}" a "${extractedName}"`);
        
        const { error: updateError } = await supabaseAdmin
          .from('leads')
          .update({ 
            name: extractedName,
            updated_at: new Date().toISOString()
          })
          .eq('id', leadId);
          
        if (updateError) {
          console.error('[EMAIL_SYNC] Error al actualizar nombre del lead:', updateError);
          return false;
        }
        
        console.log(`[EMAIL_SYNC] ✅ Nombre del lead actualizado exitosamente`);
        return true;
      } else {
        console.log(`[EMAIL_SYNC] ℹ️ El nombre actual "${currentName}" ya es bueno, no se actualiza`);
        return false;
      }
    } else {
      console.log(`[EMAIL_SYNC] ⚠️ No se pudo extraer un nombre mejor del email`);
      return false;
    }
  } catch (error) {
    console.error('[EMAIL_SYNC] Error al actualizar nombre del lead:', error);
    return false;
  }
}

// Main POST endpoint to sync sent emails
export async function POST(request: NextRequest) {
  try {
    // Get and validate request data
    const requestData = await request.json();
    console.log('[EMAIL_SYNC] Request data received:', JSON.stringify(requestData, null, 2));
    
    // Normalizar datos del request para aceptar tanto camelCase como snake_case
    const normalizedData = CaseConverterService.normalizeRequestData(requestData, 'snake');
    console.log('[EMAIL_SYNC] Normalized data:', JSON.stringify(normalizedData, null, 2));
    
    const validationResult = EmailSyncRequestSchema.safeParse(normalizedData);
    
    if (!validationResult.success) {
      console.error("[EMAIL_SYNC] Validation error details:", JSON.stringify({
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
    
    console.log('[EMAIL_SYNC] Validation successful, parsed data:', JSON.stringify(validationResult.data, null, 2));
    
    // Extraer parámetros usando getFlexibleProperty para máxima compatibilidad
    const siteId = getFlexibleProperty(requestData, 'site_id') || validationResult.data.site_id;
    const limit = getFlexibleProperty(requestData, 'limit') || validationResult.data.limit || 10;
    
    // Buscar fecha desde múltiples fuentes (prioritario: since_date, fallback: since)
    const sinceDateFromRequest = getFlexibleProperty(requestData, 'since_date') || validationResult.data.since_date;
    const sinceFromRequest = getFlexibleProperty(requestData, 'since') || validationResult.data.since;
    const sinceDate = sinceDateFromRequest || sinceFromRequest;
    
    console.log('[EMAIL_SYNC] Extracted parameters:', {
      siteId, 
      limit, 
      sinceDate,
      source: sinceDateFromRequest ? 'since_date' : sinceFromRequest ? 'since' : 'none'
    });
    
    // Si no se especifica fecha, usar las últimas 24 horas para ser más permisivo
    const finalSinceDate = sinceDate || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    
    console.log('[EMAIL_SYNC] Final since date:', {
      original: sinceDate,
      final: finalSinceDate,
      isDefault: !sinceDate
    });
    
    try {
      // Get email configuration
      console.log(`[EMAIL_SYNC] 🔧 Obteniendo configuración de email para sitio: ${siteId}`);
      const emailConfig = await EmailConfigService.getEmailConfig(siteId);
      console.log(`[EMAIL_SYNC] ✅ Configuración de email obtenida exitosamente`);
      console.log(`[EMAIL_SYNC] 📋 Configuración de email:`, {
        host: emailConfig.imapHost || emailConfig.host,
        port: emailConfig.imapPort,
        user: emailConfig.user || emailConfig.email,
        useOAuth: emailConfig.useOAuth || false,
        hasPassword: !!emailConfig.password,
        hasAccessToken: !!emailConfig.accessToken
      });
      
      // Fetch sent emails
      console.log(`[EMAIL_SYNC] 📤 Obteniendo emails ENVIADOS con límite: ${limit}, desde: ${finalSinceDate}${sinceDate ? '' : ' (fecha por defecto - últimas 24h)'}`);
      
      let allSentEmails = [];
      try {
        allSentEmails = await EmailService.fetchSentEmails(emailConfig, limit, finalSinceDate);
        console.log(`[EMAIL_SYNC] ✅ Emails enviados obtenidos exitosamente: ${allSentEmails.length} emails`);
      } catch (emailFetchError) {
        console.error(`[EMAIL_SYNC] ❌ Error al obtener emails enviados:`, emailFetchError);
        
        // Si el error es por no encontrar la carpeta de enviados, intentar con un rango más amplio sin filtro de fecha
        if (emailFetchError instanceof Error && emailFetchError.message.includes('carpeta de emails enviados')) {
          console.log(`[EMAIL_SYNC] 🔄 Reintentando sin filtro de fecha para encontrar carpeta de enviados...`);
          try {
            allSentEmails = await EmailService.fetchSentEmails(emailConfig, limit);
            console.log(`[EMAIL_SYNC] ✅ Emails enviados obtenidos exitosamente sin filtro de fecha: ${allSentEmails.length} emails`);
          } catch (retryError) {
            console.error(`[EMAIL_SYNC] ❌ Error en reintento:`, retryError);
            throw emailFetchError; // Lanzar el error original
          }
        } else {
          throw emailFetchError;
        }
      }
      
      if (allSentEmails.length === 0) {
        // Información adicional para debugging cuando no se encuentran emails
        console.log(`[EMAIL_SYNC] ℹ️ Información de debugging - No se encontraron emails:`);
        console.log(`[EMAIL_SYNC] - Site ID: ${siteId}`);
        console.log(`[EMAIL_SYNC] - Límite: ${limit}`);
        console.log(`[EMAIL_SYNC] - Fecha desde: ${finalSinceDate}`);
        console.log(`[EMAIL_SYNC] - Configuración de host: ${emailConfig.imapHost || emailConfig.host}`);
        console.log(`[EMAIL_SYNC] - Usuario: ${emailConfig.user || emailConfig.email}`);
        console.log(`[EMAIL_SYNC] - Usa OAuth: ${emailConfig.useOAuth || false}`);
        
        return NextResponse.json({
          success: true,
          message: "No se encontraron emails enviados para sincronizar",
          emailCount: 0,
          processedCount: 0,
          results: [],
          debug_info: {
            site_id: siteId,
            limit,
            since_date_used: finalSinceDate,
            was_default_date: !sinceDate,
            email_config: {
              host: emailConfig.imapHost || emailConfig.host,
              port: emailConfig.imapPort,
              user: emailConfig.user || emailConfig.email,
              useOAuth: emailConfig.useOAuth || false
            }
          }
        });
      }
      
      // Filter emails sent to internal domains (first filter)
      console.log(`[EMAIL_SYNC] 🔒 Filtrando emails enviados a dominios internos...`);
      const internalDomains = getInternalDomains();
      console.log(`[EMAIL_SYNC] 🔒 Dominios internos configurados para filtrado:`, internalDomains);
      
      const internalFilteredEmails = allSentEmails.filter(email => {
        const validation = validateEmailNotToInternalDomains(email);
        if (!validation.isValid) {
          console.log(`[EMAIL_SYNC] 🚫 Email excluido (dominio interno): To: ${email.to} - ${validation.reason}`);
          return false;
        }
        return true;
      });
      
      const preFilteredInternalCount = allSentEmails.length - internalFilteredEmails.length;
      
      // Additional guard: ensure they are truly site → external based on site config
      const siteUrlDomain = await SiteEmailGuardService.getSiteUrlDomain(siteId);
      const siteToExternal = SiteEmailGuardService.filterSiteToExternalSent(internalFilteredEmails, emailConfig, { siteId, siteUrlDomain });
      if (siteToExternal.excluded > 0) {
        console.log(`[EMAIL_SYNC] Guard excluded ${siteToExternal.excluded} emails not classified as site→external`);
      }

      // Filter emails using specialized SentEmailDuplicationService (second filter)
      console.log(`[EMAIL_SYNC] 🔄 Filtrando emails ENVIADOS ya procesados usando SentEmailDuplicationService...`);
      const { unprocessed: sentEmails, alreadyProcessed, debugInfo } = await SentEmailDuplicationService.filterUnprocessedSentEmails(
        siteToExternal.sent, 
        siteId
      );
      
      console.log(`[EMAIL_SYNC] 📈 RESUMEN DE FILTRADO DETALLADO:`);
      console.log(`[EMAIL_SYNC] - Emails enviados obtenidos inicialmente: ${allSentEmails.length}`);
      console.log(`[EMAIL_SYNC] - Emails después del filtro de dominios internos: ${internalFilteredEmails.length}`);
      console.log(`[EMAIL_SYNC] - Emails después de validar site→external: ${siteToExternal.sent.length}`);
      console.log(`[EMAIL_SYNC] - Emails ya procesados (duplicados evitados): ${alreadyProcessed.length}`);
      console.log(`[EMAIL_SYNC] - Emails finales para sincronización: ${sentEmails.length}`);
      
      // Log detallado de debug para identificar problemas
      console.log(`[EMAIL_SYNC] 🔍 DEBUG INFO de emails procesados:`);
      debugInfo.forEach((info, index) => {
        console.log(`[EMAIL_SYNC] ${index + 1}. To: ${info.emailTo} | ID: ${info.standardEmailId} | Decisión: ${info.decision}`);
      });
      
      if (sentEmails.length === 0) {
        return NextResponse.json({
          success: true,
          message: "Todos los emails enviados ya han sido sincronizados previamente",
          emailCount: allSentEmails.length,
          processedCount: 0,
          alreadyProcessedCount: alreadyProcessed.length,
          results: []
        });
      }
      
      // Logging de configuración de filtros internos ya aplicados anteriormente
      
      // Procesar cada email enviado
      console.log(`[EMAIL_SYNC] 🔄 Procesando ${sentEmails.length} emails enviados...`);
      const results = [];
      let processedCount = 0;
      let newLeadsCount = 0;
      let statusUpdatedCount = 0;
      let namesUpdatedCount = 0;
      let tasksCreatedCount = 0;
      let skippedInternalCount = 0;
      let assignedToTeamMemberCount = 0;
      let threadsDetectedCount = 0;
      let threadEmailsSyncedCount = 0;
      let messagesNotCreatedCount = 0; // Contador para mensajes no creados por falta de contenido
      
      for (const email of sentEmails) {
        const result = await processSentEmail(email, siteId);
        results.push({
          email_to: email.to,
          email_subject: email.subject,
          email_date: email.date,
          ...result
        });
        
        if (result.success) {
          processedCount++;
          if (result.isNewLead) newLeadsCount++;
          if (result.statusUpdated) statusUpdatedCount++;
          if (result.nameUpdated) namesUpdatedCount++;
          if (result.taskId) tasksCreatedCount++;
          if (result.assignedToTeamMember) assignedToTeamMemberCount++;
          if (result.threadSync) {
            threadsDetectedCount++;
            threadEmailsSyncedCount += result.threadSync.processedCount;
          }
          // Contar si no se pudo crear el mensaje por falta de contenido
          if (!result.messageId) {
            messagesNotCreatedCount++;
          }
        } else if (result.skipped) {
          skippedInternalCount++;
        }
      }
      
      console.log(`[EMAIL_SYNC] ✅ Sincronización completada:`);
      console.log(`[EMAIL_SYNC] - Emails enviados encontrados: ${allSentEmails.length}`);
      console.log(`[EMAIL_SYNC] - Emails ya procesados (duplicados evitados): ${alreadyProcessed.length}`);
      console.log(`[EMAIL_SYNC] - Emails nuevos para sincronizar: ${sentEmails.length}`);
      console.log(`[EMAIL_SYNC] - Emails procesados exitosamente: ${processedCount}`);
      console.log(`[EMAIL_SYNC] - Emails saltados (dominios internos): ${skippedInternalCount}`);
      console.log(`[EMAIL_SYNC] - Nuevos leads creados: ${newLeadsCount}`);
      console.log(`[EMAIL_SYNC] - Leads con status actualizado: ${statusUpdatedCount}`);
      console.log(`[EMAIL_SYNC] - Nombres de leads mejorados: ${namesUpdatedCount}`);
      console.log(`[EMAIL_SYNC] - Leads asignados a team members: ${assignedToTeamMemberCount}`);
      console.log(`[EMAIL_SYNC] - Tareas de first contact creadas: ${tasksCreatedCount}`);
      console.log(`[EMAIL_SYNC] - Hilos de conversación detectados: ${threadsDetectedCount}`);
      console.log(`[EMAIL_SYNC] - Emails adicionales sincronizados de hilos: ${threadEmailsSyncedCount}`);
      console.log(`[EMAIL_SYNC] - Mensajes no creados por falta de contenido: ${messagesNotCreatedCount}`);
      
      return NextResponse.json({
        success: true,
        message: "Sincronización de emails enviados completada exitosamente",
        emailCount: allSentEmails.length,
        newEmailsCount: sentEmails.length,
        alreadyProcessedCount: alreadyProcessed.length,
        processedCount,
        skippedInternalCount,
        newLeadsCount,
        statusUpdatedCount,
        namesUpdatedCount,
        assignedToTeamMemberCount,
        tasksCreatedCount,
        threadsDetectedCount,
        threadEmailsSyncedCount,
        messagesNotCreatedCount,
        internalDomainsFiltered: getInternalDomains(),
        preFilteredInternalCount,
        results
      });
      
    } catch (error: unknown) {
      console.error(`[EMAIL_SYNC] 💥 Error en el flujo principal:`, error);
      console.error(`[EMAIL_SYNC] 📋 Detalles del error:`, {
        name: error instanceof Error ? error.name : 'Unknown',
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : 'No stack trace'
      });
      
      // Determine error type and code using the service
      const errorType = error instanceof Error ? EmailSyncErrorService.determineErrorType(error) : 'fetch';
      const errorCode = errorType === 'configuration' ? ERROR_CODES.EMAIL_CONFIG_NOT_FOUND : ERROR_CODES.EMAIL_FETCH_ERROR;
      const errorMessage = error instanceof Error ? error.message : "Error procesando emails enviados";
      
      // Skip failure handler here to avoid duplicate notifications; handled by /api/agents/email
      console.log(`[EMAIL_SYNC] ℹ️ Skipping failure handler (handled by /api/agents/email)`);
      
      console.error(`[EMAIL_SYNC] 🚨 Retornando error: ${errorCode} - ${errorMessage}`);
      
      return NextResponse.json(
        {
          success: false,
          error: {
            code: errorCode,
            message: errorMessage,
          },
        },
        { status: errorType === 'configuration' ? 404 : 500 }
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

// GET method for information about the endpoint
export async function GET(request: NextRequest) {
  return NextResponse.json({
    success: true,
    message: "This endpoint synchronizes sent emails with leads, conversations, and customer journey. Use POST method with site_id, optional limit and since_date parameters.",
    method: "POST",
    required_parameters: ["site_id"],
    optional_parameters: ["limit", "since_date"],
    description: "Fetches sent emails, creates/updates leads, manages email conversations with MULTI-LEVEL DEDUPLICATION including simple channel validation and advanced stable fingerprinting (v2.0) that prevents duplicates even when HTML content differs between sent and inbox versions. Updates lead status to 'contacted', and creates 'first contact' tasks for customer journey awareness stage.",
    features: [
      "NEW: Simple channel-based duplicate detection (custom_data.channel = 'email')",
      "FAST: Primary validation using subject + recipient + temporal proximity",
      "ADVANCED: Stable email deduplication using content fingerprinting (v2.0)",
      "ROBUST: HTML-agnostic duplicate detection based on semantic content",
      "SMART: Multi-level validation (channel -> stable hash -> semantic hash -> time windows)",
      "Duplicate prevention using SyncedObjectsService",
      "Internal domain filtering (Uncodie domains)",
      "Intelligent email content extraction with character encoding fixes",
      "Smart contact name extraction from email headers and addresses",
      "Lead creation and status management",
      "Automatic lead name improvement from extracted contact information",
      "Email conversation tracking",
      "First contact task automation",
      "Team member detection by email",
      "Automatic lead assignment to team members who sent the email",
      "Thread detection and synchronization",
      "Automatic sync of related thread emails from recipients",
      "Complete conversation context reconstruction"
    ],
    deduplication_levels: {
      "1_channel_validation": "Fast check using custom_data.channel='email' with subject+recipient+time",
      "2_stable_fingerprinting": "Advanced content-based validation with stable hashing",
      "3_email_id_fallback": "Legacy validation using email IDs",
      "4_content_similarity": "Semantic content comparison for final validation"
    },
    response_fields: {
      emailCount: "Total emails found in sent folder",
      newEmailsCount: "New emails processed (excluding duplicates and internal domains)",
      alreadyProcessedCount: "Emails already processed in previous runs",
      processedCount: "Successfully processed emails in this run",
      preFilteredInternalCount: "Emails filtered out during initial processing (sent to internal domains)",
      skippedInternalCount: "Emails skipped during individual processing due to internal domains",
      newLeadsCount: "New leads created from sent emails",
      statusUpdatedCount: "Leads with updated status",
      namesUpdatedCount: "Leads with improved names extracted from email headers",
      assignedToTeamMemberCount: "Leads assigned to team members who sent the email",
      tasksCreatedCount: "First contact tasks created",
      threadsDetectedCount: "Email threads detected and processed",
      threadEmailsSyncedCount: "Additional emails from threads synchronized",
      messagesNotCreatedCount: "Messages not created due to insufficient or invalid content",
      internalDomainsFiltered: "List of internal domains that are filtered out"
    }
  }, { status: 200 });
} 