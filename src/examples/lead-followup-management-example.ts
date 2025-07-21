/**
 * EJEMPLO DE USO: API de Gestión de Follow-up de Leads
 * 
 * Esta API permite ejecutar el flujo completo de seguimiento de leads
 * para un sitio específico, procesando múltiples leads automáticamente.
 */

// Ejemplo básico - Solo site_id requerido
const basicExample = {
  site_id: "12345678-1234-1234-1234-123456789abc"
};

// Ejemplo con filtros personalizados para leads
const advancedExample = {
  site_id: "12345678-1234-1234-1234-123456789abc",
  lead_filters: {
    status: ["contacted", "qualified", "nurture"], // Estados de leads a procesar
    created_since_days: 30, // Solo leads creados en los últimos 30 días
    last_interaction_days: 7, // Sin interacción en los últimos 7 días
    limit: 20 // Máximo 20 leads por ejecución
  },
  follow_up_config: {
    followUpType: "nurture", // Tipo de seguimiento
    followUpInterval: "weekly" // Intervalo de seguimiento
  }
};

// Ejemplo de respuesta exitosa
const successResponseExample = {
  success: true,
  data: {
    site_id: "12345678-1234-1234-1234-123456789abc",
    site_name: "Mi Empresa SL",
    leads_processed: 5,
    success_count: 4,
    error_count: 1,
    success_rate: "80.00%",
    filters_applied: {
      status: ["contacted", "qualified", "nurture"],
      created_since_days: 30,
      last_interaction_days: 7,
      limit: 10
    },
    config_used: {
      followUpType: "nurture",
      followUpInterval: "weekly"
    },
    results: [
      {
        lead_id: "lead-1-uuid",
        lead_name: "Juan Pérez",
        success: true,
        follow_up_data: { /* datos del flujo de seguimiento */ },
        logs_data: { /* datos de conversaciones creadas */ },
        messages_created: 2,
        conversations_created: 1,
        channels: ["email", "whatsapp"]
      },
      {
        lead_id: "lead-2-uuid",
        lead_name: "Ana García",
        success: false,
        error: { /* información del error */ },
        step_failed: "leadFollowUp"
      }
      // ... más resultados
    ],
    summary: {
      total_messages_created: 8,
      total_conversations_created: 4,
      channels_used: ["email", "whatsapp", "notification"],
      execution_time: "2024-01-15T10:30:00.000Z"
    }
  }
};

// Función de ejemplo para usar la API
export async function executeLeadFollowUpManagement(siteId: string, options?: any) {
  try {
    const payload = {
      site_id: siteId,
      ...options
    };

    const response = await fetch('/api/agents/sales/leadFollowUp/management', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const result = await response.json();
    
    if (result.success) {
      console.log(`✅ Follow-up ejecutado para ${result.data.leads_processed} leads`);
      console.log(`📊 Tasa de éxito: ${result.data.success_rate}`);
      console.log(`💬 Total mensajes creados: ${result.data.summary.total_messages_created}`);
      console.log(`🗣️ Conversaciones creadas: ${result.data.summary.total_conversations_created}`);
      console.log(`📱 Canales utilizados: ${result.data.summary.channels_used.join(', ')}`);
      
      return result.data;
    } else {
      console.error('❌ Error en el follow-up:', result.error);
      throw new Error(result.error.message);
    }
  } catch (error) {
    console.error('❌ Error ejecutando lead follow-up management:', error);
    throw error;
  }
}

// Ejemplos de uso
export const usageExamples = {
  // Uso básico - Solo site_id
  basic: () => executeLeadFollowUpManagement("12345678-1234-1234-1234-123456789abc"),
  
  // Con filtros personalizados
  withFilters: () => executeLeadFollowUpManagement(
    "12345678-1234-1234-1234-123456789abc",
    {
      lead_filters: {
        status: ["contacted", "qualified"],
        created_since_days: 15,
        limit: 5
      }
    }
  ),
  
  // Con configuración personalizada
  withCustomConfig: () => executeLeadFollowUpManagement(
    "12345678-1234-1234-1234-123456789abc",
    {
      lead_filters: {
        status: ["nurture"],
        last_interaction_days: 14,
        limit: 25
      },
      follow_up_config: {
        followUpType: "aggressive",
        followUpInterval: "daily"
      }
    }
  )
};

/**
 * CONFIGURACIONES RECOMENDADAS POR CASO DE USO
 */

// Para leads nuevos (recién contactados)
export const newLeadsConfig = {
  lead_filters: {
    status: ["contacted"],
    created_since_days: 7,
    limit: 15
  },
  follow_up_config: {
    followUpType: "welcome",
    followUpInterval: "daily"
  }
};

// Para leads en nurturing
export const nurturingLeadsConfig = {
  lead_filters: {
    status: ["qualified", "nurture"],
    last_interaction_days: 14,
    limit: 20
  },
  follow_up_config: {
    followUpType: "nurture",
    followUpInterval: "weekly"
  }
};

// Para leads fríos (reactivación)
export const coldLeadsConfig = {
  lead_filters: {
    status: ["cold", "unqualified"],
    last_interaction_days: 30,
    created_since_days: 90,
    limit: 10
  },
  follow_up_config: {
    followUpType: "reactivation",
    followUpInterval: "monthly"
  }
}; 