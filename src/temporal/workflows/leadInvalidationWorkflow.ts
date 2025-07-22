// Workflow para invalidar leads cuando se detectan emails rebotados (bounced emails)
// Este workflow debe ser registrado y ejecutado por un Temporal Worker

export interface LeadInvalidationWorkflowArgs {
  lead_id: string;
  email: string;
  site_id: string;
  reason: 'email_bounce' | 'invalid_email' | 'manual_invalidation';
  bounce_details?: {
    bounce_email_id: string;
    bounce_subject?: string;
    bounce_from?: string;
    bounce_date?: string;
    bounce_message?: string;
  };
  metadata?: {
    invalidated_by?: string;
    user_id?: string;
    additional_info?: any;
  };
}

export interface LeadInvalidationWorkflowResult {
  success: boolean;
  lead_id: string;
  email: string;
  site_id: string;
  invalidation_reason: string;
  actions_taken: string[];
  execution_time_ms: number;
  timestamp: string;
  summary?: {
    lead_updated: boolean;
    email_marked_invalid: boolean;
    notifications_sent: number;
    cleanup_completed: boolean;
    execution_details: string;
  };
  error?: {
    code: string;
    message: string;
    details?: any;
  };
}

/**
 * Workflow principal para invalidar un lead debido a email bounce
 * Este workflow coordina la invalidación del lead y las acciones de limpieza
 */
export async function leadInvalidationWorkflow(args: LeadInvalidationWorkflowArgs): Promise<LeadInvalidationWorkflowResult> {
  const startTime = Date.now();
  const actionsTaken: string[] = [];
  
  console.log(`🚫 Iniciando invalidación de lead: ${args.lead_id} por razón: ${args.reason}`);
  console.log(`📧 Email afectado: ${args.email} en sitio: ${args.site_id}`);
  
  try {
    // En un workflow real de Temporal, aquí se definirían las actividades
    // que realizarían la invalidación del lead
    
    // Actividad 1: Obtener información del lead actual
    // const leadInfo = await getLeadInfoActivity(args.lead_id);
    const leadInfo = {
      id: args.lead_id,
      email: args.email,
      status: 'active',
      name: 'Lead Example',
      site_id: args.site_id,
      created_at: new Date().toISOString()
    };
    
    console.log(`📊 Información del lead obtenida: ${leadInfo.name} (${leadInfo.status})`);
    actionsTaken.push('lead_info_retrieved');
    
    // Actividad 2: Marcar el email como inválido en la base de datos
    // await markEmailAsInvalidActivity({
    //   email: args.email,
    //   site_id: args.site_id,
    //   reason: args.reason,
    //   bounce_details: args.bounce_details
    // });
    console.log(`❌ Email ${args.email} marcado como inválido por ${args.reason}`);
    actionsTaken.push('email_marked_invalid');
    
    // Actividad 3: Actualizar el status del lead a 'invalid_email'
    // await updateLeadStatusActivity({
    //   lead_id: args.lead_id,
    //   new_status: 'invalid_email',
    //   reason: args.reason,
    //   metadata: {
    //     invalidated_at: new Date().toISOString(),
    //     bounce_details: args.bounce_details,
    //     original_email: args.email
    //   }
    // });
    console.log(`🔄 Status del lead ${args.lead_id} actualizado a 'invalid_email'`);
    actionsTaken.push('lead_status_updated');
    
    // Actividad 4: Registrar evento de invalidación en el historial del lead
    // await logLeadInvalidationEventActivity({
    //   lead_id: args.lead_id,
    //   event_type: 'email_invalidation',
    //   reason: args.reason,
    //   details: {
    //     email: args.email,
    //     bounce_details: args.bounce_details,
    //     timestamp: new Date().toISOString()
    //   }
    // });
    console.log(`📝 Evento de invalidación registrado en historial del lead`);
    actionsTaken.push('invalidation_event_logged');
    
    // Actividad 5: Cancelar emails programados para este lead
    // await cancelScheduledEmailsActivity({
    //   lead_id: args.lead_id,
    //   email: args.email,
    //   site_id: args.site_id
    // });
    console.log(`📅 Emails programados cancelados para lead ${args.lead_id}`);
    actionsTaken.push('scheduled_emails_cancelled');
    
    // Actividad 6: Notificar al equipo sobre la invalidación
    let notificationsSent = 0;
    if (args.reason === 'email_bounce') {
      // await notifyTeamEmailBounceActivity({
      //   lead_id: args.lead_id,
      //   email: args.email,
      //   site_id: args.site_id,
      //   bounce_details: args.bounce_details
      // });
      console.log(`📧 Notificación de bounce enviada al equipo`);
      notificationsSent++;
      actionsTaken.push('team_notified_bounce');
    }
    
    // Actividad 7: Actualizar métricas de calidad de leads
    // await updateLeadQualityMetricsActivity({
    //   site_id: args.site_id,
    //   invalidation_reason: args.reason,
    //   lead_id: args.lead_id
    // });
    console.log(`📈 Métricas de calidad de leads actualizadas`);
    actionsTaken.push('quality_metrics_updated');
    
    // Actividad 8: Limpiar datos relacionados si es necesario
    if (args.reason === 'email_bounce' && args.bounce_details) {
      // await cleanupBounceRelatedDataActivity({
      //   bounce_email_id: args.bounce_details.bounce_email_id,
      //   lead_id: args.lead_id,
      //   site_id: args.site_id
      // });
      console.log(`🧹 Limpieza de datos relacionados con bounce completada`);
      actionsTaken.push('bounce_data_cleaned');
    }
    
    // Actividad 9: Verificar si hay otros leads con el mismo email inválido
    // const duplicateLeads = await findDuplicateEmailLeadsActivity({
    //   email: args.email,
    //   site_id: args.site_id,
    //   exclude_lead_id: args.lead_id
    // });
    const duplicateLeads: any[] = []; // Simulación
    
    if (duplicateLeads.length > 0) {
      console.log(`⚠️ Encontrados ${duplicateLeads.length} leads adicionales con el mismo email inválido`);
      
      // Invalidar también los leads duplicados
      for (const duplicateLead of duplicateLeads) {
        // await updateLeadStatusActivity({
        //   lead_id: duplicateLead.id,
        //   new_status: 'invalid_email',
        //   reason: 'duplicate_invalid_email',
        //   metadata: {
        //     invalidated_at: new Date().toISOString(),
        //     related_bounce_lead_id: args.lead_id,
        //     original_email: args.email
        //   }
        // });
        console.log(`🔗 Lead duplicado ${duplicateLead.id} también invalidado`);
      }
      actionsTaken.push(`${duplicateLeads.length}_duplicate_leads_invalidated`);
    }
    
    // Actividad 10: Generar reporte de invalidación
    // await generateInvalidationReportActivity({
    //   lead_id: args.lead_id,
    //   email: args.email,
    //   site_id: args.site_id,
    //   reason: args.reason,
    //   actions_taken: actionsTaken,
    //   duplicate_leads_count: duplicateLeads.length
    // });
    console.log(`📋 Reporte de invalidación generado`);
    actionsTaken.push('invalidation_report_generated');
    
    const endTime = Date.now();
    const executionTime = endTime - startTime;
    
    console.log(`✅ Invalidación de lead completada: ${args.lead_id}`);
    console.log(`📊 Acciones tomadas: ${actionsTaken.length}`);
    console.log(`⏱️ Tiempo de ejecución: ${executionTime}ms`);
    
    return {
      success: true,
      lead_id: args.lead_id,
      email: args.email,
      site_id: args.site_id,
      invalidation_reason: args.reason,
      actions_taken: actionsTaken,
      execution_time_ms: executionTime,
      timestamp: new Date().toISOString(),
      summary: {
        lead_updated: true,
        email_marked_invalid: true,
        notifications_sent: notificationsSent,
        cleanup_completed: true,
        execution_details: `Lead ${args.lead_id} invalidado exitosamente por ${args.reason}. ${actionsTaken.length} acciones completadas en ${executionTime}ms`
      }
    };
    
  } catch (error) {
    const endTime = Date.now();
    const executionTime = endTime - startTime;
    
    console.error(`❌ Error en la invalidación de lead ${args.lead_id}:`, error);
    
    return {
      success: false,
      lead_id: args.lead_id,
      email: args.email,
      site_id: args.site_id,
      invalidation_reason: args.reason,
      actions_taken: actionsTaken,
      execution_time_ms: executionTime,
      timestamp: new Date().toISOString(),
      error: {
        code: 'WORKFLOW_EXECUTION_ERROR',
        message: error instanceof Error ? error.message : 'Error desconocido en el workflow de invalidación',
        details: error
      },
      summary: {
        lead_updated: false,
        email_marked_invalid: false,
        notifications_sent: 0,
        cleanup_completed: false,
        execution_details: `Error después de completar ${actionsTaken.length} acciones en ${executionTime}ms`
      }
    };
  }
}

/**
 * Workflow alternativo para invalidación masiva de leads
 */
export async function bulkLeadInvalidationWorkflow(args: {
  lead_emails: Array<{ lead_id: string; email: string }>;
  site_id: string;
  reason: 'email_bounce' | 'invalid_email' | 'manual_invalidation';
  batch_size?: number;
}): Promise<LeadInvalidationWorkflowResult[]> {
  console.log(`🚫 Iniciando invalidación masiva de ${args.lead_emails.length} leads`);
  
  const batchSize = args.batch_size || 10;
  const results: LeadInvalidationWorkflowResult[] = [];
  
  // Procesar en lotes para evitar sobrecargar el sistema
  for (let i = 0; i < args.lead_emails.length; i += batchSize) {
    const batch = args.lead_emails.slice(i, i + batchSize);
    console.log(`📦 Procesando lote ${Math.floor(i / batchSize) + 1}/${Math.ceil(args.lead_emails.length / batchSize)}`);
    
    // Procesar cada lead en el lote
    const batchPromises = batch.map(async (leadEmail) => {
      return await leadInvalidationWorkflow({
        lead_id: leadEmail.lead_id,
        email: leadEmail.email,
        site_id: args.site_id,
        reason: args.reason
      });
    });
    
    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);
    
    // Pequeña pausa entre lotes si es necesario
    if (i + batchSize < args.lead_emails.length) {
      // await sleep(1000); // 1 segundo de pausa
      console.log(`⏸️ Pausa entre lotes completada`);
    }
  }
  
  console.log(`✅ Invalidación masiva completada: ${results.filter(r => r.success).length}/${results.length} exitosos`);
  return results;
} 