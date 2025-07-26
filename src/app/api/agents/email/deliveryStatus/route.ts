/**
 * API de Email Delivery Status - Maneja correos de Mail Delivery Subsystem (bounced emails)
 * Route: POST /api/agents/email/deliveryStatus
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { EmailService } from '@/lib/services/email/EmailService';
import { EmailConfigService } from '@/lib/services/email/EmailConfigService';
import { WorkflowService } from '@/lib/services/workflow-service';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { CaseConverterService, getFlexibleProperty } from '@/lib/utils/case-converter';

// Configuración de timeout extendido para Vercel (máximo 800s para plan pro)
export const maxDuration = 800; // Incrementado de 300 a 800 para consistencia con ruta principal

// Create schemas for request validation
const DeliveryStatusRequestSchema = z.object({
  site_id: z.string().min(1, "Site ID is required"),
  // Coercion para aceptar strings y tope máximo a 30
  limit: z.coerce.number().max(30).default(20),
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
    // Aceptar "limit" en cualquier formato y garantizar número válido <=30
    const requestedLimitRaw = getFlexibleProperty(requestData, 'limit');
    const requestedLimit = requestedLimitRaw !== undefined && requestedLimitRaw !== null ? Number(requestedLimitRaw) : validationResult.data.limit;

    // Si la conversión falla, fallback a 20
    const sanitizedLimit = !isNaN(requestedLimit) ? requestedLimit : 20;

    // Limitar siempre a 30 como valor máximo
    const limit = Math.min(sanitizedLimit, 30);
    const sinceDate = getFlexibleProperty(requestData, 'since_date') || validationResult.data.since_date;
    
    console.log('[DELIVERY_STATUS] Extracted parameters:', {
      siteId, limit, sinceDate
    });
    
    try {
      // Get email configuration
      console.log(`[DELIVERY_STATUS] 🔧 Obteniendo configuración de email para sitio: ${siteId}`);
      const emailConfig = await EmailConfigService.getEmailConfig(siteId);
      console.log(`[DELIVERY_STATUS] ✅ Configuración de email obtenida exitosamente`);
      
      // Fetch emails from INBOX (simple and direct like other routes)
      console.log(`[DELIVERY_STATUS] 📥 Obteniendo emails con límite: ${limit}, desde: ${sinceDate || 'sin límite de fecha'}`);
      const allEmails = await EmailService.fetchEmails(emailConfig, limit, sinceDate);
      console.log(`[DELIVERY_STATUS] ✅ Emails obtenidos exitosamente: ${allEmails.length} emails`);
      
      // Filter for bounce emails (simple and direct)
      console.log(`[DELIVERY_STATUS] 🔍 Filtrando emails de bounce/delivery failure...`);
      const bounceEmails = allEmails.filter(email => {
        const from = (email.from || '').toLowerCase();
        const subject = (email.subject || '').toLowerCase();
        const body = (email.body || '').toLowerCase();
        
        return (
          from.includes('mail delivery subsystem') ||
          from.includes('mailer-daemon') ||
          from.includes('postmaster') ||
          subject.includes('delivery status notification') ||
          subject.includes('undelivered mail') ||
          subject.includes('delivery failure') ||
          body.includes('delivery failed') ||
          body.includes('user unknown') ||
          body.includes('permanent failure')
        );
      });
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
      
      // Process each bounce email (simple processing)
      const maxBouncesToProcess = Math.min(bounceEmails.length, 10);
      const bouncesToProcess = bounceEmails.slice(0, maxBouncesToProcess);
      
      console.log(`[DELIVERY_STATUS] 🔄 Procesando ${bouncesToProcess.length} bounce emails (de ${bounceEmails.length} encontrados)...`);
      const results = [];
      let workflowsTriggered = 0;
      let emailsDeleted = 0;
      
      for (const bounceEmail of bouncesToProcess) {
        try {
          console.log(`[DELIVERY_STATUS] 📧 Procesando bounce email ID: ${bounceEmail.id}, Subject: ${bounceEmail.subject}`);
          
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
          
          // Call leadInvalidationWorkflow (simple and direct)
          console.log(`[DELIVERY_STATUS] 🔄 Iniciando workflow de invalidación para lead: ${leadId}...`);
          const workflowService = WorkflowService.getInstance();
          
          const workflowResult = await workflowService.leadInvalidation(
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
                bounce_message: bounceEmail.body?.substring(0, 500)
              }
            },
            {
              taskQueue: process.env.WORKFLOW_TASK_QUEUE || 'default',
              workflowId: `lead-invalidation-${leadId}-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
              async: true,
              priority: 'high'
            }
          );
          
          if (workflowResult.success) {
            console.log(`[DELIVERY_STATUS] ✅ Workflow de invalidación iniciado: ${workflowResult.workflowId}`);
            workflowsTriggered++;
          } else {
            console.error(`[DELIVERY_STATUS] ❌ Error en workflow de invalidación:`, workflowResult.error);
          }
          
          // Delete the bounce email from server (simple and direct)
          console.log(`[DELIVERY_STATUS] 🗑️ Eliminando bounce email del servidor...`);
          const bounceDeleted = await deleteEmailFromServer(emailConfig, bounceEmail.id, false);
          
          // Skip searching for original sent emails (can be done as separate task if needed)
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
          ? `Se procesaron solo los primeros ${bouncesToProcess.length} bounce emails de ${bounceEmails.length} encontrados (límite: 10 por ejecución)`
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
export async function GET() {
  return NextResponse.json({
    success: false,
    message: 'Método no permitido. Utiliza POST para procesar el delivery status.'
  }, {
    status: 405,
    headers: {
      Allow: 'POST'
    }
  });
} 