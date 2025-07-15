import { LeadAssignmentService } from '@/lib/services/lead-assignment-service';

/**
 * Ejemplo de uso del servicio de asignación de leads
 */
export async function leadAssignmentExamples() {
  
  // Ejemplo 1: Asignación manual básica
  console.log('🎯 Ejemplo 1: Asignación manual básica');
  try {
    const result = await LeadAssignmentService.assignLead({
      lead_id: '550e8400-e29b-41d4-a716-446655440000',
      assignee_id: '550e8400-e29b-41d4-a716-446655440002',
      brief: 'Lead de alta calidad que mostró interés en nuestro producto premium. Viene de una empresa Fortune 500 con presupuesto confirmado.',
      next_steps: [
        'Llamar dentro de las próximas 2 horas',
        'Enviar información del producto premium',
        'Programar demo personalizada',
        'Preparar propuesta comercial'
      ],
      priority: 'high',
      due_date: '2024-12-31T18:00:00Z',
      additional_context: 'CEO de empresa tecnológica, presupuesto de $75k, necesita implementación en Q1 2025',
      include_team_notification: true,
      metadata: {
        lead_source: 'website_demo',
        campaign_id: 'premium_trial_2024',
        lead_score: 92
      }
    });
    
    console.log('✅ Asignación exitosa:', result.success);
    console.log('📧 Emails enviados:', result.data?.emails_sent);
  } catch (error) {
    console.error('❌ Error en asignación:', error);
  }

  // Ejemplo 2: Asignación automática basada en lead score
  console.log('\n🤖 Ejemplo 2: Asignación automática');
  try {
    const autoResult = await LeadAssignmentService.autoAssignLead({
      lead_id: '550e8400-e29b-41d4-a716-446655440001',
      assignee_id: '550e8400-e29b-41d4-a716-446655440002',
      leadOrigin: 'website',
      leadScore: 85,
      campaignId: 'marketing_campaign_2024'
    });
    
    console.log('✅ Asignación automática exitosa:', autoResult.success);
    console.log('📋 Brief generado:', autoResult.data?.assignment_details.brief);
  } catch (error) {
    console.error('❌ Error en asignación automática:', error);
  }

  // Ejemplo 3: Reasignación de lead
  console.log('\n🔄 Ejemplo 3: Reasignación de lead');
  try {
    const reassignResult = await LeadAssignmentService.reassignLead({
      lead_id: '550e8400-e29b-41d4-a716-446655440001',
      new_assignee_id: '550e8400-e29b-41d4-a716-446655440003',
      reason: 'Especialización en sector tecnológico requerida',
      previous_assignee_id: '550e8400-e29b-41d4-a716-446655440002',
      urgent: true
    });
    
    console.log('✅ Reasignación exitosa:', reassignResult.success);
    console.log('🔔 Notificaciones enviadas:', reassignResult.data?.notifications_sent);
  } catch (error) {
    console.error('❌ Error en reasignación:', error);
  }

  // Ejemplo 4: Asignación de alta prioridad
  console.log('\n🚨 Ejemplo 4: Asignación de alta prioridad');
  try {
    const urgentResult = await LeadAssignmentService.assignHighPriorityLead({
      lead_id: '550e8400-e29b-41d4-a716-446655440004',
      assignee_id: '550e8400-e29b-41d4-a716-446655440002',
      brief: 'URGENTE: Lead de empresa multinacional con decisión inmediata. Competidor fuerte en la mesa.',
      due_date: '2024-12-21T17:00:00Z',
      context: 'Reunión de directorio mañana, necesitan propuesta antes de las 5 PM'
    });
    
    console.log('✅ Asignación urgente exitosa:', urgentResult.success);
    console.log('⏰ Fecha límite:', urgentResult.data?.assignment_details.due_date);
  } catch (error) {
    console.error('❌ Error en asignación urgente:', error);
  }

  // Ejemplo 5: Asignación masiva
  console.log('\n📋 Ejemplo 5: Asignación masiva');
  try {
    const bulkAssignments = [
      {
        lead_id: '550e8400-e29b-41d4-a716-446655440005',
        assignee_id: '550e8400-e29b-41d4-a716-446655440002',
        brief: 'Lead de marketing digital',
        priority: 'normal' as const
      },
      {
        lead_id: '550e8400-e29b-41d4-a716-446655440006',
        assignee_id: '550e8400-e29b-41d4-a716-446655440003',
        brief: 'Lead de e-commerce',
        priority: 'high' as const
      },
      {
        lead_id: '550e8400-e29b-41d4-a716-446655440007',
        assignee_id: '550e8400-e29b-41d4-a716-446655440002',
        brief: 'Lead de consultoría',
        priority: 'normal' as const
      }
    ];

    const bulkResults = await LeadAssignmentService.bulkAssignLeads(bulkAssignments);
    
    console.log('✅ Asignaciones masivas completadas:', bulkResults.length);
    console.log('📊 Resultados exitosos:', bulkResults.filter(r => r.success).length);
  } catch (error) {
    console.error('❌ Error en asignación masiva:', error);
  }
}

/**
 * Ejemplo de flujo completo de asignación de leads
 */
export async function completeLeadAssignmentFlow() {
  console.log('🔄 Iniciando flujo completo de asignación de leads');
  
  // Simulación de datos de un lead nuevo
  const newLead = {
    id: '550e8400-e29b-41d4-a716-446655440010',
    name: 'Carlos Rodríguez',
    email: 'carlos.rodriguez@techcorp.com',
    phone: '+52-555-123-4567',
    company: 'TechCorp Solutions',
    origin: 'website',
    lead_score: 88,
    campaign_id: 'enterprise_demo_2024'
  };

  // Paso 1: Determinar el vendedor más apropiado
  console.log('👥 Paso 1: Seleccionando vendedor apropiado...');
  const selectedAssignee = await selectBestAssignee(newLead);
  
  if (!selectedAssignee) {
    console.error('❌ No se encontró vendedor disponible');
    return;
  }

  // Paso 2: Crear brief personalizado
  console.log('📝 Paso 2: Creando brief personalizado...');
  const brief = createPersonalizedBrief(newLead);

  // Paso 3: Definir siguientes pasos según el perfil del lead
  console.log('📋 Paso 3: Definiendo siguientes pasos...');
  const nextSteps = defineNextSteps(newLead);

  // Paso 4: Asignar lead con notificación
  console.log('🎯 Paso 4: Asignando lead y enviando notificaciones...');
  try {
    const assignmentResult = await LeadAssignmentService.assignLead({
      lead_id: newLead.id,
      assignee_id: selectedAssignee.id,
      brief,
      next_steps: nextSteps,
      priority: newLead.lead_score > 80 ? 'high' : 'normal',
      additional_context: `Lead Score: ${newLead.lead_score}/100. Empresa: ${newLead.company}`,
      include_team_notification: newLead.lead_score > 85, // Notificar al equipo solo para leads de alta calidad
      metadata: {
        lead_score: newLead.lead_score,
        campaign_id: newLead.campaign_id,
        assignment_method: 'automated_flow',
        company: newLead.company
      }
    });

    if (assignmentResult.success) {
      console.log('✅ Flujo de asignación completado exitosamente');
      console.log('📧 Notificaciones enviadas:', assignmentResult.data?.emails_sent);
      console.log('👤 Vendedor asignado:', assignmentResult.data?.assignee_info.name);
    } else {
      console.error('❌ Error en el flujo de asignación:', assignmentResult.error);
    }
  } catch (error) {
    console.error('❌ Error en asignación:', error);
  }
}

// Funciones auxiliares para el ejemplo

async function selectBestAssignee(lead: any): Promise<{id: string, name: string, email: string} | null> {
  // En un caso real, esto consultaría la base de datos para encontrar el mejor vendedor
  // basado en disponibilidad, especialización, carga de trabajo, etc.
  console.log(`🔍 Seleccionando vendedor para lead de ${lead.company}...`);
  
  // Simulación de selección
  const availableAssignees = [
    { id: '550e8400-e29b-41d4-a716-446655440002', name: 'María García', email: 'maria.garcia@empresa.com', specialty: 'enterprise' },
    { id: '550e8400-e29b-41d4-a716-446655440003', name: 'Juan Pérez', email: 'juan.perez@empresa.com', specialty: 'smb' },
    { id: '550e8400-e29b-41d4-a716-446655440004', name: 'Ana López', email: 'ana.lopez@empresa.com', specialty: 'tech' }
  ];

  // Lógica de selección basada en el score y origen
  if (lead.lead_score > 80) {
    return availableAssignees[0]; // Mejor vendedor para leads de alta calidad
  } else if (lead.origin === 'website') {
    return availableAssignees[2]; // Especialista en tech para leads web
  }
  
  return availableAssignees[1]; // Vendedor general
}

function createPersonalizedBrief(lead: any): string {
  const scoreDescription = lead.lead_score > 80 ? 'alta calidad' : 
                          lead.lead_score > 60 ? 'buena calidad' : 'calidad moderada';
  
  return `Lead de ${scoreDescription} generado desde ${lead.origin}. 
          Contacto: ${lead.name} de ${lead.company}. 
          Score: ${lead.lead_score}/100. 
          ${lead.campaign_id ? `Campaña: ${lead.campaign_id}. ` : ''}
          Este lead ha mostrado interés significativo en nuestros servicios y requiere seguimiento personalizado.`;
}

function defineNextSteps(lead: any): string[] {
  const baseSteps = [
    `Contactar a ${lead.name} dentro de las próximas 4 horas`,
    'Calificar necesidades específicas y presupuesto',
    'Registrar resultado de la primera interacción'
  ];

  if (lead.lead_score > 80) {
    return [
      `PRIORIDAD: Contactar a ${lead.name} dentro de 2 horas`,
      'Preparar propuesta personalizada',
      'Programar demo del producto',
      'Involucrar al equipo técnico si es necesario',
      ...baseSteps.slice(1)
    ];
  }

  if (lead.origin === 'website') {
    return [
      'Revisar páginas visitadas en el sitio web',
      ...baseSteps,
      'Enviar material informativo relevante'
    ];
  }

  return baseSteps;
}

// Ejecutar ejemplos si se ejecuta directamente
if (typeof require !== 'undefined' && require.main === module) {
  console.log('🚀 Ejecutando ejemplos de asignación de leads...\n');
  
  leadAssignmentExamples()
    .then(() => {
      console.log('\n🔄 Ejecutando flujo completo...\n');
      return completeLeadAssignmentFlow();
    })
    .then(() => {
      console.log('\n✅ Todos los ejemplos completados');
    })
    .catch((error) => {
      console.error('\n❌ Error ejecutando ejemplos:', error);
    });
} 