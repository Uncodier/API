/**
 * API de Email Delivery Status - Maneja correos de bounce/delivery failure
 * Route: POST /api/agents/email/deliveryStatus
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { EmailService } from '@/lib/services/email/EmailService';
import { EmailConfigService } from '@/lib/services/email/EmailConfigService';
import { EmailTextExtractorService } from '@/lib/services/email/EmailTextExtractorService';
import { WorkflowService } from '@/lib/services/workflow-service';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { CaseConverterService, getFlexibleProperty } from '@/lib/utils/case-converter';

// Configuración de timeout extendido para Vercel
export const maxDuration = 800;

// Create schemas for request validation
const DeliveryStatusRequestSchema = z.object({
  site_id: z.string().min(1, "Site ID is required"),
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
 * Detecta si un email es un bounce/delivery failure
 */
function isBounceEmail(email: any): boolean {
  const from = (email.from || '').toLowerCase();
  const subject = (email.subject || '').toLowerCase();
  
  // Filtros para from
  const bounceFromPatterns = [
    'mailer-daemon',
    'mail delivery subsystem',
    'postmaster',
    'mail.protection.outlook.com',
    'no-reply',
    'noreply'
  ];
  
  // Filtros para subject
  const bounceSubjectPatterns = [
    'delivery status notification',
    'failure',
    'undelivered mail',
    'delivery failure',
    'returned mail',
    'mail delivery failed',
    'undeliverable',
    'bounce',
    'could not be delivered'
  ];
  
  const isFromBounce = bounceFromPatterns.some(pattern => from.includes(pattern));
  const isSubjectBounce = bounceSubjectPatterns.some(pattern => subject.includes(pattern));
  
  return isFromBounce || isSubjectBounce;
}

/**
 * Extrae emails (direcciones con @) del texto del bounce email
 */
function extractEmailAddressesFromBounce(email: any): string[] {
  const extractedText = EmailTextExtractorService.extractEmailText(email);
  const fullText = `${extractedText.subject} ${extractedText.extractedText}`;
  
  // Regex para extraer emails válidos
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const matches = fullText.match(emailRegex) || [];
  
  // Filtrar emails únicos y limpiar
  const uniqueEmails = Array.from(new Set(matches.map(email => email.toLowerCase().trim())));
  
  console.log(`[DELIVERY_STATUS] Emails extraídos del bounce: ${uniqueEmails.join(', ')}`);
  return uniqueEmails;
}

/**
 * Busca leads por email en la base de datos
 */
async function findLeadsByEmails(emails: string[], siteId: string): Promise<{email: string, leadId: string}[]> {
  if (emails.length === 0) return [];
  
  try {
    const { data, error } = await supabaseAdmin
      .from('leads')
      .select('id, email')
      .in('email', emails)
      .eq('site_id', siteId);

    if (error) {
      console.error(`[DELIVERY_STATUS] Error buscando leads:`, error);
      return [];
    }

    return (data || []).map(lead => ({
      email: lead.email,
      leadId: lead.id
    }));
  } catch (error) {
    console.error(`[DELIVERY_STATUS] Error en consulta de leads:`, error);
    return [];
  }
}

/**
 * Elimina un email del servidor IMAP
 */
async function deleteEmailFromServer(emailConfig: any, emailId: string): Promise<boolean> {
  try {
    console.log(`[DELIVERY_STATUS] 🗑️ Eliminando bounce email ${emailId} del servidor`);
    const success = await EmailService.deleteEmail(emailConfig, emailId, false);
    
    if (success) {
      console.log(`[DELIVERY_STATUS] ✅ Email ${emailId} eliminado exitosamente`);
    } else {
      console.log(`[DELIVERY_STATUS] ⚠️ Email ${emailId} no pudo ser eliminado`);
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
    const requestedLimitRaw = getFlexibleProperty(requestData, 'limit');
    const requestedLimit = requestedLimitRaw !== undefined && requestedLimitRaw !== null ? Number(requestedLimitRaw) : validationResult.data.limit;
    const sanitizedLimit = !isNaN(requestedLimit) ? requestedLimit : 20;
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
      
      // Fetch emails from INBOX
      console.log(`[DELIVERY_STATUS] 📥 Obteniendo emails con límite: ${limit}, desde: ${sinceDate || 'sin límite de fecha'}`);
      const allEmails = await EmailService.fetchEmails(emailConfig, limit, sinceDate);
      console.log(`[DELIVERY_STATUS] ✅ Emails obtenidos exitosamente: ${allEmails.length} emails`);
      
      // Filter emails by size to prevent memory issues
      console.log(`[DELIVERY_STATUS] 🔍 Verificando tamaños de emails para prevenir problemas de memoria...`);
      const MAX_EMAIL_SIZE = 50000; // 50KB máximo por email
      const originalEmailCount = allEmails.length;
      
      const sizeFilteredEmails = allEmails.filter((email, index) => {
        const emailSize = JSON.stringify(email).length;
        if (emailSize > MAX_EMAIL_SIZE) {
          console.log(`[DELIVERY_STATUS] 🚫 Email ${index + 1} excede tamaño máximo: ${emailSize} caracteres (máximo: ${MAX_EMAIL_SIZE})`);
          console.log(`[DELIVERY_STATUS] 🚫 Email excluido - From: ${email.from}, Subject: ${email.subject}`);
          return false;
        }
        return true;
      });
      
      console.log(`[DELIVERY_STATUS] 📊 Filtro de tamaño completado: ${sizeFilteredEmails.length}/${originalEmailCount} emails dentro del límite de tamaño`);
      
      // Filter for bounce emails
      console.log(`[DELIVERY_STATUS] 🔍 Filtrando emails de bounce/delivery failure...`);
      const bounceEmails = [];
      
      for (let i = 0; i < sizeFilteredEmails.length; i++) {
        const email = sizeFilteredEmails[i];
        console.log(`[DELIVERY_STATUS] 🔍 Analizando email ${i + 1}/${sizeFilteredEmails.length} - From: ${email.from?.substring(0, 50)}, Subject: ${email.subject?.substring(0, 50)}`);
        
        if (isBounceEmail(email)) {
          console.log(`[DELIVERY_STATUS] ✅ Bounce email detectado: ${email.from} - ${email.subject}`);
          bounceEmails.push(email);
        }
      }
      
      console.log(`[DELIVERY_STATUS] 📊 Bounce emails encontrados: ${bounceEmails.length}/${sizeFilteredEmails.length}`);
      
      if (bounceEmails.length === 0) {
        return NextResponse.json({
          success: true,
          message: "No se encontraron emails de bounce/delivery failure",
          totalEmails: originalEmailCount,
          sizeFilteredEmails: sizeFilteredEmails.length,
          bounceEmails: 0,
          processedBounces: 0,
          workflowsTriggered: 0,
          emailsDeleted: 0,
          filteredBySize: originalEmailCount > sizeFilteredEmails.length
        });
      }
      
      // Process each bounce email
      const maxBouncesToProcess = Math.min(bounceEmails.length, 10);
      const bouncesToProcess = bounceEmails.slice(0, maxBouncesToProcess);
      
      console.log(`[DELIVERY_STATUS] 🔄 Procesando ${bouncesToProcess.length} bounce emails (de ${bounceEmails.length} encontrados)...`);
      const results = [];
      let workflowsTriggered = 0;
      let emailsDeleted = 0;
      
      for (const bounceEmail of bouncesToProcess) {
        try {
          console.log(`[DELIVERY_STATUS] 📧 Procesando bounce email ID: ${bounceEmail.id}, Subject: ${bounceEmail.subject}`);
          
          // Extract email addresses from bounce message
          const extractedEmails = extractEmailAddressesFromBounce(bounceEmail);
          
          if (extractedEmails.length === 0) {
            console.log(`[DELIVERY_STATUS] ⚠️ No se pudieron extraer emails del bounce: ${bounceEmail.id}`);
            results.push({
              bounceEmailId: bounceEmail.id,
              success: false,
              reason: 'No se pudieron extraer emails del mensaje de bounce'
            });
            continue;
          }
          
          console.log(`[DELIVERY_STATUS] 📮 Emails extraídos: ${extractedEmails.join(', ')}`);
          
          // Find leads by emails
          const leadsFound = await findLeadsByEmails(extractedEmails, siteId);
          
          if (leadsFound.length === 0) {
            console.log(`[DELIVERY_STATUS] ⚠️ No se encontraron leads para emails: ${extractedEmails.join(', ')}`);
            results.push({
              bounceEmailId: bounceEmail.id,
              extractedEmails,
              success: false,
              reason: 'No se encontraron leads asociados a los emails'
            });
            continue;
          }
          
          console.log(`[DELIVERY_STATUS] 👥 Leads encontrados: ${leadsFound.length}`);
          
          // Process each lead found
          const leadResults = [];
          for (const { email, leadId } of leadsFound) {
            console.log(`[DELIVERY_STATUS] 🔄 Iniciando workflow de invalidación para lead: ${leadId} (email: ${email})...`);
            const workflowService = WorkflowService.getInstance();
            
            const workflowResult = await workflowService.leadInvalidation(
              {
                lead_id: leadId,
                email: email,
                site_id: siteId,
                reason: 'email_bounce',
                bounce_details: {
                  bounce_email_id: bounceEmail.id,
                  bounce_subject: bounceEmail.subject,
                  bounce_from: bounceEmail.from,
                  bounce_date: bounceEmail.date,
                  bounce_message: `Extracted emails: ${extractedEmails.join(', ')}`
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
            
            leadResults.push({
              leadId,
              email,
              workflowTriggered: workflowResult.success,
              workflowId: workflowResult.workflowId,
              error: workflowResult.error
            });
          }
          
          // Delete the bounce email from server
          console.log(`[DELIVERY_STATUS] 🗑️ Eliminando bounce email del servidor...`);
          const bounceDeleted = await deleteEmailFromServer(emailConfig, bounceEmail.id);
          
          if (bounceDeleted) {
            emailsDeleted++;
          }
          
          results.push({
            bounceEmailId: bounceEmail.id,
            extractedEmails,
            leadsFound: leadResults,
            bounceEmailDeleted: bounceDeleted,
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
        totalEmails: originalEmailCount,
        sizeFilteredEmails: sizeFilteredEmails.length,
        bounceEmails: bounceEmails.length,
        processedBounces: results.length,
        workflowsTriggered,
        emailsDeleted,
        filteredBySize: originalEmailCount > sizeFilteredEmails.length,
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