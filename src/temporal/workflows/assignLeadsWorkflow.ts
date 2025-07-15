// Workflow para asignar leads a miembros del equipo
// Este workflow debe ser registrado y ejecutado por un Temporal Worker

export interface AssignLeadsWorkflowArgs {
  site_id: string;
}

export interface AssignLeadsWorkflowResult {
  success: boolean;
  site_id: string;
  totalLeadsAssigned: number;
  assignmentDetails: Array<{
    teamMemberId: string;
    assignedLeads: number;
    assignedAt: string;
  }>;
  executionTime: number;
  timestamp: string;
  summary?: {
    total_leads_processed: number;
    successful_assignments: number;
    failed_assignments: number;
    execution_details: string;
  };
  error?: {
    code: string;
    message: string;
    details?: any;
  };
}

/**
 * Workflow principal para asignación de leads
 * Este workflow se encarga de distribuir leads entre los miembros del equipo
 * basándose en reglas de asignación configuradas por sitio
 */
export async function assignLeadsWorkflow(args: AssignLeadsWorkflowArgs): Promise<AssignLeadsWorkflowResult> {
  const startTime = Date.now();
  const { site_id } = args;
  
  console.log(`📋 Iniciando asignación de leads para sitio: ${site_id}`);
  
  const assignmentDetails: Array<{
    teamMemberId: string;
    assignedLeads: number;
    assignedAt: string;
  }> = [];
  
  try {
    // En un workflow real de Temporal, aquí se definirían las actividades
    // que realizarían la asignación de leads
    
    // Actividad 1: Obtener leads pendientes de asignación
    // const pendingLeads = await fetchPendingLeadsActivity(site_id);
    const pendingLeads = [
      { id: 'lead_1', name: 'Juan Pérez', email: 'juan@example.com', priority: 'high' },
      { id: 'lead_2', name: 'María García', email: 'maria@example.com', priority: 'medium' },
      { id: 'lead_3', name: 'Carlos López', email: 'carlos@example.com', priority: 'low' },
      { id: 'lead_4', name: 'Ana Martínez', email: 'ana@example.com', priority: 'high' }
    ];
    
    console.log(`📊 Leads pendientes encontrados: ${pendingLeads.length}`);
    
    // Actividad 2: Obtener miembros del equipo disponibles
    // const teamMembers = await fetchAvailableTeamMembersActivity(site_id);
    const teamMembers = [
      { id: 'team_1', name: 'Agente Ventas 1', capacity: 5, current_leads: 2 },
      { id: 'team_2', name: 'Agente Ventas 2', capacity: 3, current_leads: 1 },
      { id: 'team_3', name: 'Agente Ventas 3', capacity: 4, current_leads: 0 }
    ];
    
    console.log(`👥 Miembros del equipo disponibles: ${teamMembers.length}`);
    
    // Actividad 3: Aplicar reglas de asignación
    // const assignmentRules = await getAssignmentRulesActivity(site_id);
    const assignmentRules = {
      strategy: 'round_robin', // round_robin, priority_based, capacity_based
      priority_weights: { high: 3, medium: 2, low: 1 },
      max_assignments_per_batch: 10
    };
    
    console.log(`📝 Reglas de asignación: ${JSON.stringify(assignmentRules)}`);
    
    // Actividad 4: Ejecutar asignación de leads
    for (const lead of pendingLeads) {
      try {
        // Encontrar el mejor miembro del equipo para asignar
        const bestMember = teamMembers.reduce((best, member) => {
          const availableCapacity = member.capacity - member.current_leads;
          const bestAvailableCapacity = best.capacity - best.current_leads;
          
          if (availableCapacity > bestAvailableCapacity) {
            return member;
          }
          return best;
        });
        
        if (bestMember.capacity > bestMember.current_leads) {
          // Asignar el lead al miembro del equipo
          // await assignLeadToTeamMemberActivity(lead.id, bestMember.id);
          
          bestMember.current_leads++;
          
          // Buscar si ya existe un detalle para este miembro
          const existingDetail = assignmentDetails.find(detail => detail.teamMemberId === bestMember.id);
          if (existingDetail) {
            existingDetail.assignedLeads++;
          } else {
            assignmentDetails.push({
              teamMemberId: bestMember.id,
              assignedLeads: 1,
              assignedAt: new Date().toISOString()
            });
          }
          
          console.log(`✅ Lead ${lead.name} asignado a ${bestMember.name}`);
          
          // Actividad 5: Notificar al miembro del equipo
          // await notifyTeamMemberActivity(bestMember.id, lead);
          console.log(`📧 Notificación enviada a ${bestMember.name} sobre nuevo lead`);
          
        } else {
          console.log(`⚠️ No hay capacidad disponible para asignar lead ${lead.name}`);
        }
        
      } catch (assignmentError) {
        console.error(`❌ Error asignando lead ${lead.name}:`, assignmentError);
        continue;
      }
    }
    
    // Actividad 6: Actualizar métricas del sitio
    // await updateSiteMetricsActivity(site_id, assignmentDetails);
    const totalAssigned = assignmentDetails.reduce((total, detail) => total + detail.assignedLeads, 0);
    console.log(`📈 Métricas actualizadas para sitio ${site_id}: ${totalAssigned} leads asignados`);
    
    // Actividad 7: Enviar resumen de asignaciones
    // await sendAssignmentSummaryActivity(site_id, assignmentDetails);
    console.log(`📋 Resumen de asignaciones enviado para sitio ${site_id}`);
    
    const endTime = Date.now();
    const executionTime = endTime - startTime;
    
    console.log(`✅ Asignación de leads completada para sitio ${site_id}`);
    console.log(`📊 Total de leads asignados: ${totalAssigned}`);
    console.log(`⏱️ Tiempo de ejecución: ${executionTime}ms`);
    
    return {
      success: true,
      site_id,
      totalLeadsAssigned: totalAssigned,
      assignmentDetails,
      executionTime,
      timestamp: new Date().toISOString(),
      summary: {
        total_leads_processed: pendingLeads.length,
        successful_assignments: totalAssigned,
        failed_assignments: pendingLeads.length - totalAssigned,
        execution_details: `Se asignaron ${totalAssigned} de ${pendingLeads.length} leads en ${executionTime}ms`
      }
    };
    
  } catch (error) {
    const endTime = Date.now();
    const executionTime = endTime - startTime;
    
    console.error(`❌ Error en la asignación de leads para sitio ${site_id}:`, error);
    
    const totalAssigned = assignmentDetails.reduce((total, detail) => total + detail.assignedLeads, 0);
    
    return {
      success: false,
      site_id,
      totalLeadsAssigned: totalAssigned,
      assignmentDetails,
      executionTime,
      timestamp: new Date().toISOString(),
      error: {
        code: 'WORKFLOW_EXECUTION_ERROR',
        message: error instanceof Error ? error.message : 'Error desconocido en el workflow',
        details: error
      },
      summary: {
        total_leads_processed: 0,
        successful_assignments: totalAssigned,
        failed_assignments: 1,
        execution_details: `Error después de asignar ${totalAssigned} leads en ${executionTime}ms`
      }
    };
  }
} 