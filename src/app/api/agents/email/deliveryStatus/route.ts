/**
 * API de Email Delivery Status - Maneja correos de Mail Delivery Subsystem (bounced emails)
 * Route: POST /api/agents/email/deliveryStatus
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { EmailService } from '@/lib/services/email/EmailService';
import { EmailConfigService } from '@/lib/services/email/EmailConfigService';
import { EmailFilterService } from '@/lib/services/email/EmailFilterService';
import { WorkflowService } from '@/lib/services/workflow-service';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { CaseConverterService, getFlexibleProperty } from '@/lib/utils/case-converter';

// Configuración de timeout extendido para Vercel (máximo 800s para plan pro)
export const maxDuration = 300; // 5 minutos en segundos

// Create schemas for request validation
const DeliveryStatusRequestSchema = z.object({
  site_id: z.string().min(1, "Site ID is required"),
  limit: z.number().default(10).optional(), // Cambiado de 20 a 10 para mayor estabilidad
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
  WORKFLOW_ERROR: 'WORKFLOW_ERROR',
  EMAIL_DELETE_ERROR: 'EMAIL_DELETE_ERROR'
};

/**
 * Extrae el email original de un mensaje de bounce
 */
function extractOriginalEmailFromBounce(bounceMessage: string): string | null {
  // Patrones comunes para extraer el email de un mensaje de bounce
  const patterns = [
    /The following addresses had permanent fatal errors:\s*([^\s<>]+@[^\s<>]+)/i,
    /failed delivery to:\s*([^\s<>]+@[^\s<>]+)/i,
    /could not be delivered to:\s*([^\s<>]+@[^\s<>]+)/i,
    /delivery to the following recipient failed:\s*([^\s<>]+@[^\s<>]+)/i,
    /recipient address rejected:\s*([^\s<>]+@[^\s<>]+)/i,
    /user unknown.*:\s*([^\s<>]+@[^\s<>]+)/i,
    /mailbox unavailable.*:\s*([^\s<>]+@[^\s<>]+)/i,
    /final-recipient:\s*rfc822;\s*([^\s<>]+@[^\s<>]+)/i,
    /<([^\s<>]+@[^\s<>]+)>:?\s*(?:host|delivery)/i,
    /to\s+([^\s<>]+@[^\s<>]+).*failed/i,
    /([^\s<>]+@[^\s<>]+).*user unknown/i,
    /([^\s<>]+@[^\s<>]+).*does not exist/i,
  ];

  for (const pattern of patterns) {
    const match = bounceMessage.match(pattern);
    if (match && match[1]) {
      const email = match[1].trim().toLowerCase();
      // Validar que el email extraído sea válido
      if (isValidEmail(email)) {
        return email;
      }
    }
  }

  return null;
}

/**
 * Busca el lead_id basado en el email extraído del bounce
 */
async function findLeadByEmail(email: string, siteId: string): Promise<string | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from('leads')
      .select('id')
      .eq('email', email)
      .eq('site_id', siteId)
      .single();

    if (error || !data) {
      console.log(`[DELIVERY_STATUS] No se encontró lead para email: ${email}`);
      return null;
    }

    return data.id;
  } catch (error) {
    console.error(`[DELIVERY_STATUS] Error buscando lead por email ${email}:`, error);
    return null;
  }
}



/**
 * Función para validar email
 */
function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Elimina un email del servidor IMAP
 */
async function deleteEmailFromServer(emailConfig: any, emailId: string, isFromSent: boolean = false): Promise<boolean> {
  try {
    console.log(`[DELIVERY_STATUS] 🗑️ Eliminando email ${emailId} del servidor (isFromSent: ${isFromSent})`);
    const success = await EmailService.deleteEmail(emailConfig, emailId, isFromSent);
    
    if (success) {
      console.log(`[DELIVERY_STATUS] ✅ Email ${emailId} eliminado exitosamente`);
    } else {
      console.log(`[DELIVERY_STATUS] ⚠️ Email ${emailId} no pudo ser eliminado (posiblemente no encontrado)`);
    }
    
    return success;
  } catch (error) {
    console.error(`[DELIVERY_STATUS] ❌ Error eliminando email ${emailId}:`, error);
    return false;
  }
}

/**
 * Main POST endpoint para procesar delivery status
 */
export async function POST(request: NextRequest) {
  try {
    // Get and validate request data
    const requestData = await request.json();
    console.log('[DELIVERY_STATUS] Request data received:', JSON.stringify(requestData, null, 2));
    
    // Normalizar datos del request
    const normalizedData = CaseConverterService.normalizeRequestData(requestData, 'snake');
    console.log('[DELIVERY_STATUS] Normalized data:', JSON.stringify(normalizedData, null, 2));
    
    const validationResult = DeliveryStatusRequestSchema.safeParse(normalizedData);
    
    if (!validationResult.success) {
      console.error("[DELIVERY_STATUS] Validation error details:", JSON.stringify({
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
    
    console.log('[DELIVERY_STATUS] Validation successful, parsed data:', JSON.stringify(validationResult.data, null, 2));
    
    // Extraer parámetros
    const siteId = getFlexibleProperty(requestData, 'site_id') || validationResult.data.site_id;
    const requestedLimit = getFlexibleProperty(requestData, 'limit') || validationResult.data.limit || 10;
    // Limitar a máximo 10 emails para evitar timeouts
    const limit = Math.min(requestedLimit, 10);
    const sinceDate = getFlexibleProperty(requestData, 'since_date') || validationResult.data.since_date;
    
    console.log('[DELIVERY_STATUS] Extracted parameters:', {
      siteId, limit, sinceDate
    });
    
    try {
      // Get email configuration
      console.log(`[DELIVERY_STATUS] 🔧 Obteniendo configuración de email para sitio: ${siteId}`);
      const emailConfig = await EmailConfigService.getEmailConfig(siteId);
      console.log(`[DELIVERY_STATUS] ✅ Configuración de email obtenida exitosamente`);
      
      // Fetch emails from INBOX con timeout solo para la operación de fetch
      console.log(`[DELIVERY_STATUS] 📥 Obteniendo emails con límite: ${limit}, desde: ${sinceDate || 'sin límite de fecha'}`);
      
      const fetchEmailsPromise = EmailService.fetchEmails(emailConfig, limit, sinceDate);
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Timeout al obtener emails del servidor (30s)')), 30000);
      });
      
      const allEmails = await Promise.race([fetchEmailsPromise, timeoutPromise]);
      console.log(`[DELIVERY_STATUS] ✅ Emails obtenidos exitosamente: ${allEmails.length} emails`);
      
      // Filter for bounce emails with timeout para evitar que emails grandes causen timeouts
      console.log(`[DELIVERY_STATUS] 🔍 Filtrando emails de bounce/delivery failure...`);
      
      const filteringPromise = new Promise<any[]>((resolve) => {
        // Filtrado optimizado sin EmailFilterService para evitar timeouts
        const bounceEmails = allEmails.filter((email, index) => {
          // Solo log cada 5 emails para evitar spam de logs
          if (index % 5 === 0) {
            console.log(`[DELIVERY_STATUS] 🔍 Procesando email ${index + 1}/${allEmails.length}...`);
          }
          
          // Optimized bounce detection (sin usar EmailFilterService que puede ser lento)
          const from = (email.from || '').toLowerCase();
          const subject = (email.subject || '').toLowerCase();
          
          // Solo analizar los primeros 1000 caracteres del body para evitar emails grandes
          const body = (email.body || '').substring(0, 1000).toLowerCase();
          
          // Quick bounce detection usando solo strings básicas
          const isBounce = (
            from.includes('mail delivery subsystem') ||
            from.includes('mailer-daemon') ||
            from.includes('postmaster') ||
            from.includes('mail delivery system') ||
            subject.includes('delivery status notification') ||
            subject.includes('undelivered mail') ||
            subject.includes('delivery failure') ||
            subject.includes('returned mail') ||
            subject.includes('failure notice') ||
            body.includes('delivery failed') ||
            body.includes('user unknown') ||
            body.includes('mailbox unavailable') ||
            body.includes('permanent failure') ||
            body.includes('recipient address rejected')
          );
          
          // Log solo los bounces encontrados
          if (isBounce) {
            console.log(`[DELIVERY_STATUS] 📧 Bounce detectado: ID=${email.id}, From=${email.from}, Subject=${email.subject?.substring(0, 50)}...`);
          }
          
          return isBounce;
        });
        
        resolve(bounceEmails);
      });
      
      const filteringTimeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Timeout en filtrado de emails (20s)')), 20000);
      });
      
      const bounceEmails = await Promise.race([filteringPromise, filteringTimeoutPromise]);
      console.log(`[DELIVERY_STATUS] 📊 Bounce emails encontrados: ${bounceEmails.length}/${allEmails.length}`);
      
      if (bounceEmails.length === 0) {
        return NextResponse.json({
          success: true,
          message: "No se encontraron emails de Mail Delivery Subsystem",
          totalEmails: allEmails.length,
          bounceEmails: 0,
          processedBounces: 0,
          workflowsTriggered: 0,
          emailsDeleted: 0
        });
      }
      
      // Process each bounce email (limit to 3 max to avoid timeouts)
      const maxBouncesToProcess = Math.min(bounceEmails.length, 3);
      const bouncesToProcess = bounceEmails.slice(0, maxBouncesToProcess);
      
      console.log(`[DELIVERY_STATUS] 🔄 Procesando ${bouncesToProcess.length} bounce emails (de ${bounceEmails.length} encontrados)...`);
      const results = [];
      let workflowsTriggered = 0;
      let emailsDeleted = 0;
      
      // Timeout general para todo el procesamiento (120 segundos)
      const processingStartTime = Date.now();
      const maxProcessingTime = 120000; // 2 minutos
      
      for (const bounceEmail of bouncesToProcess) {
        // Verificar timeout general
        if (Date.now() - processingStartTime > maxProcessingTime) {
          console.warn(`[DELIVERY_STATUS] ⏰ Timeout general alcanzado, deteniendo procesamiento`);
          results.push({
            bounceEmailId: bounceEmail.id,
            success: false,
            reason: 'Timeout general alcanzado - procesamiento detenido'
          });
          break;
        }
        try {
          console.log(`[DELIVERY_STATUS] 📧 Procesando bounce email ID: ${bounceEmail.id}, Subject: ${bounceEmail.subject}`);
          
          // Timeout individual por email (60 segundos)
          const emailProcessingStart = Date.now();
          const maxEmailProcessingTime = 60000; // 60 segundos por email
          
          // Extract original email address from bounce message
          const originalEmail = extractOriginalEmailFromBounce(bounceEmail.body || '');
          
          if (!originalEmail) {
            console.log(`[DELIVERY_STATUS] ⚠️ No se pudo extraer email original del bounce: ${bounceEmail.id}`);
            results.push({
              bounceEmailId: bounceEmail.id,
              success: false,
              reason: 'No se pudo extraer email original del mensaje de bounce'
            });
            continue;
          }
          
          console.log(`[DELIVERY_STATUS] 📮 Email original extraído: ${originalEmail}`);
          
          // Verificar timeout individual
          if (Date.now() - emailProcessingStart > maxEmailProcessingTime) {
            console.warn(`[DELIVERY_STATUS] ⏰ Timeout individual alcanzado para email ${bounceEmail.id}`);
            results.push({
              bounceEmailId: bounceEmail.id,
              originalEmail,
              success: false,
              reason: 'Timeout individual de procesamiento (60s)'
            });
            continue;
          }
          
          // Find lead by email
          const leadId = await findLeadByEmail(originalEmail, siteId);
          
          if (!leadId) {
            console.log(`[DELIVERY_STATUS] ⚠️ No se encontró lead para email: ${originalEmail}`);
            results.push({
              bounceEmailId: bounceEmail.id,
              originalEmail,
              success: false,
              reason: 'No se encontró lead asociado al email'
            });
            continue;
          }
          
          console.log(`[DELIVERY_STATUS] 👤 Lead encontrado: ${leadId} para email: ${originalEmail}`);
          
          // Call leadInvalidationWorkflow con timeout
          console.log(`[DELIVERY_STATUS] 🔄 Iniciando workflow de invalidación para lead: ${leadId}...`);
          const workflowService = WorkflowService.getInstance();
          
          const workflowPromise = workflowService.leadInvalidation(
            {
              lead_id: leadId,
              email: originalEmail,
              site_id: siteId,
              reason: 'email_bounce',
              bounce_details: {
                bounce_email_id: bounceEmail.id,
                bounce_subject: bounceEmail.subject,
                bounce_from: bounceEmail.from,
                bounce_date: bounceEmail.date,
                bounce_message: bounceEmail.body?.substring(0, 500) // Limitar el mensaje
              }
            },
            {
              taskQueue: process.env.WORKFLOW_TASK_QUEUE || 'default',
              workflowId: `lead-invalidation-${leadId}-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
              async: true, // Ejecutar de forma asíncrona
              priority: 'high'
            }
          );
          
          const workflowTimeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('Timeout en workflow (30s)')), 30000);
          });
          
          let workflowResult;
          try {
            workflowResult = await Promise.race([workflowPromise, workflowTimeoutPromise]);
            
            if (workflowResult.success) {
              console.log(`[DELIVERY_STATUS] ✅ Workflow de invalidación iniciado: ${workflowResult.workflowId}`);
              workflowsTriggered++;
            } else {
              console.error(`[DELIVERY_STATUS] ❌ Error en workflow de invalidación:`, workflowResult.error);
            }
          } catch (workflowError) {
            console.warn(`[DELIVERY_STATUS] ⚠️ Error/timeout en workflow para lead ${leadId}:`, workflowError);
            workflowResult = { success: false, error: workflowError instanceof Error ? workflowError.message : String(workflowError) };
          }
          
          // Delete the bounce email from server con timeout
          console.log(`[DELIVERY_STATUS] 🗑️ Eliminando bounce email del servidor...`);
          const deletePromise = deleteEmailFromServer(emailConfig, bounceEmail.id, false);
          const deleteTimeoutPromise = new Promise<boolean>((_, reject) => {
            setTimeout(() => reject(new Error('Timeout en eliminación (20s)')), 20000);
          });
          
          let bounceDeleted = false;
          try {
            bounceDeleted = await Promise.race([deletePromise, deleteTimeoutPromise]);
          } catch (deleteError) {
            console.warn(`[DELIVERY_STATUS] ⚠️ Error/timeout eliminando email ${bounceEmail.id}:`, deleteError);
            bounceDeleted = false;
          }
          
          // Skip searching for original sent emails to avoid timeout
          // TODO: Implement this as a separate background task if needed
          const originalEmailDeleted = false;
          
          if (bounceDeleted) {
            emailsDeleted++;
          }
          
          results.push({
            bounceEmailId: bounceEmail.id,
            originalEmail,
            leadId,
            workflowTriggered: workflowResult.success,
            workflowId: workflowResult.workflowId,
            bounceEmailDeleted: bounceDeleted,
            originalEmailDeleted,
            success: true
          });
          
        } catch (processingError) {
          console.error(`[DELIVERY_STATUS] ❌ Error procesando bounce email ${bounceEmail.id}:`, processingError);
          results.push({
            bounceEmailId: bounceEmail.id,
            success: false,
            error: processingError instanceof Error ? processingError.message : String(processingError)
          });
        }
      }
      
      console.log(`[DELIVERY_STATUS] ✅ Procesamiento completado. Workflows: ${workflowsTriggered}, Emails eliminados: ${emailsDeleted}`);
      
      return NextResponse.json({
        success: true,
        message: "Procesamiento de delivery status completado",
        totalEmails: allEmails.length,
        bounceEmails: bounceEmails.length,
        processedBounces: results.length,
        workflowsTriggered,
        emailsDeleted,
        results,
        note: bouncesToProcess.length < bounceEmails.length 
          ? `Se procesaron solo los primeros ${bouncesToProcess.length} bounce emails de ${bounceEmails.length} encontrados para evitar timeouts (límite: 3 por ejecución)`
          : undefined
      });
      
    } catch (error: unknown) {
      console.error(`[DELIVERY_STATUS] 💥 Error en el flujo principal:`, error);
      
      const isConfigError = error instanceof Error && (
        error.message.includes('settings') || 
        error.message.includes('token')
      );
      
      const errorCode = isConfigError ? ERROR_CODES.EMAIL_CONFIG_NOT_FOUND : ERROR_CODES.EMAIL_FETCH_ERROR;
      const errorMessage = error instanceof Error ? error.message : "Error procesando delivery status";
      
      console.error(`[DELIVERY_STATUS] 🚨 Retornando error: ${errorCode} - ${errorMessage}`);
      
      return NextResponse.json(
        {
          success: false,
          error: {
            code: errorCode,
            message: errorMessage,
          },
        },
        { status: isConfigError ? 404 : 500 }
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

// GET method for backward compatibility
export async function GET(request: NextRequest) {
  return NextResponse.json({
    success: true,
    message: "This endpoint requires a POST request with delivery status analysis parameters. Please refer to the documentation."
  }, { status: 200 });
} 