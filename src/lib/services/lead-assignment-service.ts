// Tipos definidos en el mismo archivo por simplicidad

// Tipos de apoyo para TypeScript
export interface LeadAssignmentNotificationParams {
  lead_id: string;
  assignee_id: string;
  brief: string;
  next_steps: string[];
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  due_date?: string;
  additional_context?: string;
  include_team_notification?: boolean;
  metadata?: Record<string, any>;
}

export interface LeadAssignmentNotificationResult {
  success: boolean;
  data?: {
    lead_id: string;
    assignee_id: string;
    lead_info: {
      name: string;
      email?: string;
      phone?: string;
      status: string;
      origin?: string;
    };
    assignee_info: {
      name?: string;
      email: string;
    };
    site_info: {
      name?: string;
      url?: string;
    };
    assignment_details: {
      brief: string;
      next_steps: string[];
      priority: string;
      due_date?: string;
      additional_context?: string;
    };
    notifications_sent: {
      assignee: number;
      team: number;
    };
    emails_sent: {
      assignee: number;
      team: number;
    };
    total_recipients: {
      assignee: number;
      team: number;
    };
    assignment_updated: boolean;
    errors?: string[];
    sent_at: string;
  };
  error?: {
    code: string;
    message: string;
    details?: any;
  };
}

/**
 * Servicio para gestionar asignaciones de leads y notificaciones
 */
export class LeadAssignmentService {
  private static readonly ENDPOINT = '/api/notifications/leadAssignment';

  /**
   * Asigna un lead a un vendedor y envía las notificaciones correspondientes
   */
  static async assignLead(params: LeadAssignmentNotificationParams): Promise<LeadAssignmentNotificationResult> {
    try {
      console.log(`🎯 [LeadAssignmentService] Asignando lead ${params.lead_id} a vendedor ${params.assignee_id}`);
      
      const response = await fetch(this.ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(params),
      });

      const result = await response.json();

      if (!response.ok) {
        console.error(`❌ [LeadAssignmentService] Error en asignación:`, result);
        throw new Error(result.error?.message || 'Assignment failed');
      }

      console.log(`✅ [LeadAssignmentService] Lead asignado exitosamente`);
      return result;
    } catch (error) {
      console.error(`❌ [LeadAssignmentService] Error al asignar lead:`, error);
      throw error;
    }
  }

  /**
   * Asigna un lead de forma automática con parámetros predeterminados
   */
  static async autoAssignLead(params: {
    lead_id: string;
    assignee_id: string;
    leadOrigin?: string;
    leadScore?: number;
    campaignId?: string;
  }): Promise<LeadAssignmentNotificationResult> {
    const briefTemplate = this.generateAutoBrief(params);
    const nextSteps = this.generateDefaultNextSteps(params.leadOrigin);
    const priority = this.calculatePriority(params.leadScore);

    return this.assignLead({
      lead_id: params.lead_id,
      assignee_id: params.assignee_id,
      brief: briefTemplate,
      next_steps: nextSteps,
      priority,
      include_team_notification: false, // Por defecto no notificar al equipo en asignación automática
      metadata: {
        assignment_type: 'automatic',
        lead_score: params.leadScore,
        campaign_id: params.campaignId,
        assigned_at: new Date().toISOString()
      }
    });
  }

  /**
   * Reasigna un lead existente a un nuevo vendedor
   */
  static async reassignLead(params: {
    lead_id: string;
    new_assignee_id: string;
    reason: string;
    previous_assignee_id?: string;
    urgent?: boolean;
  }): Promise<LeadAssignmentNotificationResult> {
    const brief = `Lead reasignado: ${params.reason}`;
    const nextSteps = [
      'Revisar historial de interacciones previas con el lead',
      'Contactar al lead para presentarte como nuevo punto de contacto',
      'Revisar notas y contexto del vendedor anterior',
      'Actualizar estrategia de seguimiento según el progreso actual'
    ];

    return this.assignLead({
      lead_id: params.lead_id,
      assignee_id: params.new_assignee_id,
      brief,
      next_steps: nextSteps,
      priority: params.urgent ? 'urgent' : 'high',
      additional_context: params.previous_assignee_id 
        ? `Previamente asignado a vendedor ${params.previous_assignee_id}`
        : 'Reasignación de lead existente',
      include_team_notification: true, // Notificar al equipo en reasignaciones
      metadata: {
        assignment_type: 'reassignment',
        reason: params.reason,
        previous_assignee_id: params.previous_assignee_id,
        reassigned_at: new Date().toISOString()
      }
    });
  }

  /**
   * Asigna un lead de alta prioridad con seguimiento urgente
   */
  static async assignHighPriorityLead(params: {
    lead_id: string;
    assignee_id: string;
    brief: string;
    due_date?: string;
    context?: string;
  }): Promise<LeadAssignmentNotificationResult> {
    const urgentNextSteps = [
      'URGENTE: Contactar inmediatamente (dentro de 1 hora)',
      'Priorizar sobre otras tareas actuales',
      'Escalar a manager si no se puede contactar en 2 horas',
      'Preparar propuesta inicial en el mismo día'
    ];

    return this.assignLead({
      lead_id: params.lead_id,
      assignee_id: params.assignee_id,
      brief: params.brief,
      next_steps: urgentNextSteps,
      priority: 'urgent',
      due_date: params.due_date || this.calculateUrgentDueDate(),
      additional_context: params.context,
      include_team_notification: true, // Siempre notificar al equipo para leads urgentes
      metadata: {
        assignment_type: 'high_priority',
        escalation_required: true,
        assigned_at: new Date().toISOString()
      }
    });
  }

  /**
   * Asigna múltiples leads a diferentes vendedores
   */
  static async bulkAssignLeads(assignments: Array<{
    lead_id: string;
    assignee_id: string;
    brief?: string;
    priority?: 'low' | 'normal' | 'high' | 'urgent';
  }>): Promise<LeadAssignmentNotificationResult[]> {
    console.log(`📋 [LeadAssignmentService] Asignando ${assignments.length} leads en lote`);
    
    const results: LeadAssignmentNotificationResult[] = [];
    const errors: Error[] = [];

    for (const assignment of assignments) {
      try {
        const result = await this.assignLead({
          lead_id: assignment.lead_id,
          assignee_id: assignment.assignee_id,
          brief: assignment.brief || this.generateAutoBrief({ lead_id: assignment.lead_id }),
          next_steps: this.generateDefaultNextSteps(),
          priority: assignment.priority || 'normal',
          include_team_notification: false, // No notificar al equipo en asignaciones masivas
          metadata: {
            assignment_type: 'bulk',
            batch_size: assignments.length,
            assigned_at: new Date().toISOString()
          }
        });
        results.push(result);
      } catch (error) {
        console.error(`❌ [LeadAssignmentService] Error asignando lead ${assignment.lead_id}:`, error);
        errors.push(error as Error);
      }
    }

    if (errors.length > 0) {
      console.warn(`⚠️ [LeadAssignmentService] ${errors.length} asignaciones fallaron de ${assignments.length}`);
    }

    return results;
  }

  /**
   * Genera un brief automático basado en el contexto del lead
   */
  private static generateAutoBrief(params: {
    lead_id: string;
    leadOrigin?: string;
    leadScore?: number;
    campaignId?: string;
  }): string {
    const origin = params.leadOrigin || 'unknown';
    const score = params.leadScore || 0;
    const campaign = params.campaignId ? ` desde campaña ${params.campaignId}` : '';
    
    let brief = `Lead generado automáticamente desde ${origin}${campaign}. `;
    
    if (score > 80) {
      brief += 'Lead de alta calidad con excelente puntuación de interés. ';
    } else if (score > 60) {
      brief += 'Lead cualificado con buen potencial. ';
    } else if (score > 40) {
      brief += 'Lead con potencial moderado que requiere evaluación. ';
    } else {
      brief += 'Lead inicial que necesita cualificación. ';
    }
    
    brief += 'Revisar perfil completo y contactar según protocolo estándar.';
    
    return brief;
  }

  /**
   * Genera pasos predeterminados según el origen del lead
   */
  private static generateDefaultNextSteps(origin?: string): string[] {
    const baseSteps = [
      'Revisar perfil completo del lead en el sistema',
      'Contactar dentro de las próximas 4 horas hábiles',
      'Calificar nivel de interés y presupuesto',
      'Registrar resultado de la interacción'
    ];

    switch (origin) {
      case 'website':
        return [
          'Revisar páginas visitadas en el sitio web',
          ...baseSteps,
          'Enviar material informativo relevante'
        ];
      case 'whatsapp':
        return [
          'Revisar conversación inicial de WhatsApp',
          'Responder por WhatsApp dentro de 2 horas',
          'Calificar y migrar a llamada telefónica si es apropiado',
          'Registrar resultado de la interacción'
        ];
      case 'email':
        return [
          'Revisar email inicial y contexto',
          'Responder por email dentro de 4 horas',
          ...baseSteps.slice(2)
        ];
      case 'referral':
        return [
          'Contactar inmediatamente (lead referido)',
          'Mencionar fuente de referencia',
          'Priorizar sobre otros leads del día',
          'Registrar resultado y agradecer referencia'
        ];
      default:
        return baseSteps;
    }
  }

  /**
   * Calcula prioridad basada en el lead score
   */
  private static calculatePriority(score?: number): 'low' | 'normal' | 'high' | 'urgent' {
    if (!score) return 'normal';
    
    if (score >= 90) return 'urgent';
    if (score >= 70) return 'high';
    if (score >= 40) return 'normal';
    return 'low';
  }

  /**
   * Calcula fecha límite urgente (24 horas)
   */
  private static calculateUrgentDueDate(): string {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    return tomorrow.toISOString();
  }

  /**
   * Obtiene estadísticas de asignaciones
   */
  static async getAssignmentStats(assigneeId: string, startDate?: string, endDate?: string): Promise<{
    total_assignments: number;
    completed_assignments: number;
    pending_assignments: number;
    success_rate: number;
  }> {
    // Esta función se implementaría para obtener estadísticas de asignaciones
    // Por ahora retornamos un mock
    return {
      total_assignments: 0,
      completed_assignments: 0,
      pending_assignments: 0,
      success_rate: 0
    };
  }
} 