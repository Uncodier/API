/**
 * Ejemplos de uso del API de Lead Attention Notification
 * 
 * Esta API permite notificar a team members cuando leads asignados
 * requieren atención por haber contactado a través de diferentes canales.
 */

import { z } from 'zod';

// Tipos TypeScript para la API
export const LeadAttentionRequest = z.object({
  site_id: z.string().uuid(),
  names: z.array(z.string().min(1)).min(1),
  user_message: z.string().optional(),
  system_message: z.string().optional(),
  channel: z.enum(['email', 'whatsapp', 'phone', 'chat', 'form', 'other']).default('other'),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  contact_info: z.object({
    email: z.string().email().optional(),
    phone: z.string().optional(),
    contact_method: z.string().optional()
  }).optional(),
  additional_data: z.record(z.any()).optional()
});

export type LeadAttentionRequestType = z.infer<typeof LeadAttentionRequest>;

// Función base para llamar al API
export async function notifyLeadAttention(requestData: LeadAttentionRequestType): Promise<any> {
  try {
    const response = await fetch('/api/notifications/leadAttention', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestData)
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const result = await response.json();
    
    if (!result.success) {
      throw new Error(result.error?.message || 'Unknown error occurred');
    }

    // Verificar y mostrar información de configuración de canales
    handleChannelsConfiguration(result.data.channels_configuration);

    return result.data;
  } catch (error) {
    console.error('Error notifying lead attention:', error);
    throw error;
  }
}

// Función para manejar configuración de canales
function handleChannelsConfiguration(channelsConfig: any) {
  if (!channelsConfig.has_channels) {
    console.warn('🚨 CRITICAL WARNING:', channelsConfig.warning);
    console.warn('📋 ACTION REQUIRED: Configure at least one channel in site settings');
    console.warn('💡 Supported channels: email, whatsapp, phone, sms, chat, social');
    console.warn('⚡ Impact: Prospecting effectiveness will be seriously reduced');
  } else {
    console.log('✅ Channels properly configured:', channelsConfig.configured_channels.join(', '));
  }
}

// Ejemplo 1: Notificación básica para un lead
export async function basicLeadAttentionExample() {
  console.log('📞 Ejemplo 1: Notificación básica de atención de lead');
  
  try {
    const result = await notifyLeadAttention({
      site_id: '550e8400-e29b-41d4-a716-446655440000',
      names: ['John Doe'],
      channel: 'email',
      priority: 'normal'
    });

    console.log('✅ Notificación enviada:', result);
    return result;
  } catch (error) {
    console.error('❌ Error en notificación básica:', error);
    throw error;
  }
}

// Ejemplo 2: Múltiples leads con información completa
export async function multipleLeadsAttentionExample() {
  console.log('📞 Ejemplo 2: Notificación para múltiples leads');
  
  try {
    const result = await notifyLeadAttention({
      site_id: '550e8400-e29b-41d4-a716-446655440000',
      names: ['John Doe', 'Jane Smith', 'Robert Johnson'],
      user_message: 'I need help with my recent order and have some questions about delivery.',
      system_message: 'Multiple leads contacted through contact form within 5 minutes',
      channel: 'form',
      priority: 'high',
      contact_info: {
        email: 'contact@example.com',
        phone: '+1-555-123-4567',
        contact_method: 'Email preferred for follow-up'
      },
      additional_data: {
        source: 'Contact form',
        page: '/contact',
        utm_source: 'google',
        utm_medium: 'cpc',
        form_type: 'general_inquiry',
        timestamp: new Date().toISOString()
      }
    });

    console.log('✅ Notificaciones enviadas para múltiples leads:', result);
    return result;
  } catch (error) {
    console.error('❌ Error en notificación múltiple:', error);
    throw error;
  }
}

// Ejemplo 3: Notificación urgente de WhatsApp
export async function urgentWhatsAppAttentionExample() {
  console.log('📱 Ejemplo 3: Notificación urgente de WhatsApp');
  
  try {
    const result = await notifyLeadAttention({
      site_id: '550e8400-e29b-41d4-a716-446655440000',
      names: ['Maria García'],
      user_message: 'Hola, necesito ayuda urgente con mi pedido. No me ha llegado y era para hoy.',
      system_message: 'Customer expressing urgency about order delivery',
      channel: 'whatsapp',
      priority: 'urgent',
      contact_info: {
        phone: '+34-612-345-678',
        contact_method: 'WhatsApp only'
      },
      additional_data: {
        language: 'es',
        order_id: 'ORD-12345',
        expected_delivery: '2024-01-15',
        customer_tier: 'premium'
      }
    });

    console.log('🚨 Notificación urgente enviada:', result);
    return result;
  } catch (error) {
    console.error('❌ Error en notificación urgente:', error);
    throw error;
  }
}

// Ejemplo 4: Notificación de llamada telefónica
export async function phoneCallAttentionExample() {
  console.log('☎️ Ejemplo 4: Notificación de llamada telefónica');
  
  try {
    const result = await notifyLeadAttention({
      site_id: '550e8400-e29b-41d4-a716-446655440000',
      names: ['David Miller'],
      system_message: 'Incoming phone call - customer could not reach through other channels',
      channel: 'phone',
      priority: 'high',
      contact_info: {
        phone: '+1-555-987-6543',
        contact_method: 'Phone call scheduled for 3 PM'
      },
      additional_data: {
        call_duration: '3 minutes',
        missed_calls: 2,
        last_attempt: new Date().toISOString(),
        caller_id_verified: true
      }
    });

    console.log('📞 Notificación de llamada enviada:', result);
    return result;
  } catch (error) {
    console.error('❌ Error en notificación de llamada:', error);
    throw error;
  }
}

// Ejemplo 5: Chat en vivo con contexto
export async function liveChatAttentionExample() {
  console.log('💬 Ejemplo 5: Notificación de chat en vivo');
  
  try {
    const result = await notifyLeadAttention({
      site_id: '550e8400-e29b-41d4-a716-446655440000',
      names: ['Lisa Anderson'],
      user_message: 'Hi, I\'m looking at your premium package but have some questions about the features included.',
      system_message: 'Customer actively browsing premium pricing page for 5+ minutes',
      channel: 'chat',
      priority: 'normal',
      contact_info: {
        email: 'lisa.anderson@email.com'
      },
      additional_data: {
        session_duration: '8 minutes',
        pages_viewed: ['/pricing', '/features', '/premium'],
        chat_started_from: '/pricing',
        previous_visits: 3,
        lead_score: 85
      }
    });

    console.log('💬 Notificación de chat enviada:', result);
    return result;
  } catch (error) {
    console.error('❌ Error en notificación de chat:', error);
    throw error;
  }
}

// Ejemplo 6: Notificación por lotes para leads de un evento
export async function eventLeadsBatchNotification() {
  console.log('🎪 Ejemplo 6: Notificación por lotes de leads de evento');
  
  try {
    const result = await notifyLeadAttention({
      site_id: '550e8400-e29b-41d4-a716-446655440000',
      names: [
        'Carlos Rodriguez',
        'Anna Thompson', 
        'Michael Chang',
        'Sophie Wilson',
        'Ahmed Hassan'
      ],
      system_message: 'Leads from Trade Show 2024 - all requesting follow-up within 24 hours',
      channel: 'form',
      priority: 'high',
      additional_data: {
        event: 'Trade Show 2024',
        booth_number: 'A-205',
        event_date: '2024-01-15',
        lead_source: 'business_card_scan',
        follow_up_deadline: '2024-01-16T18:00:00Z',
        event_rep: 'Sarah Johnson'
      }
    });

    console.log('🎪 Notificaciones de evento enviadas:', result);
    return result;
  } catch (error) {
    console.error('❌ Error en notificaciones de evento:', error);
    throw error;
  }
}

// Ejemplo 7: Función helper para manejo de errores
export async function handleLeadAttentionWithRetry(
  requestData: LeadAttentionRequestType,
  maxRetries: number = 3
): Promise<any> {
  console.log(`🔄 Enviando notificación con reintentos (max: ${maxRetries})`);
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await notifyLeadAttention(requestData);
      console.log(`✅ Notificación enviada en intento ${attempt}`);
      return result;
    } catch (error) {
      console.warn(`⚠️ Intento ${attempt} falló:`, error);
      
      if (attempt === maxRetries) {
        console.error(`❌ Todos los intentos fallaron para leads: ${requestData.names.join(', ')}`);
        throw error;
      }
      
      // Esperar antes del siguiente intento
      const delay = Math.pow(2, attempt) * 1000; // Exponential backoff
      console.log(`⏳ Esperando ${delay}ms antes del siguiente intento...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// Ejemplo 8: Manejo de sitio sin canales configurados
export async function handleSiteWithoutChannelsExample() {
  console.log('⚠️ Ejemplo 8: Manejo de sitio sin canales configurados');
  
  try {
    const result = await notifyLeadAttention({
      site_id: '550e8400-e29b-41d4-a716-446655440000', // Sitio sin canales
      names: ['John Doe'],
      user_message: 'I need help with my order',
      channel: 'email',
      priority: 'normal'
    });

    // La respuesta incluirá warning sobre canales
    if (!result.channels_configuration.has_channels) {
      console.log('🚨 CONFIGURACIÓN CRÍTICA DETECTADA:');
      console.log(`   Warning: ${result.channels_configuration.warning}`);
      console.log('   Canales configurados:', result.channels_configuration.configured_channels.length);
      console.log('');
      console.log('📋 ACCIONES RECOMENDADAS:');
      console.log('   1. Acceder a configuración del sitio');
      console.log('   2. Configurar al menos un canal de comunicación');
      console.log('   3. Verificar credenciales de servicios externos');
      console.log('   4. Probar envío manual para validar configuración');
      console.log('');
      console.log('⚡ IMPACTO: La prospección automática se verá seriamente afectada');
    }

    return result;
  } catch (error) {
    console.error('❌ Error en manejo de sitio sin canales:', error);
    throw error;
  }
}

// Ejemplo 9: Wrapper para diferentes tipos de sitios
export class LeadAttentionService {
  private siteId: string;
  
  constructor(siteId: string) {
    this.siteId = siteId;
  }
  
  async notifyEcommerceLead(leadName: string, orderIssue: string, priority: 'low' | 'normal' | 'high' | 'urgent' = 'normal') {
    return await notifyLeadAttention({
      site_id: this.siteId,
      names: [leadName],
      user_message: orderIssue,
      system_message: 'E-commerce customer needs assistance with order',
      channel: 'email',
      priority,
      additional_data: {
        context: 'ecommerce',
        category: 'order_support'
      }
    });
  }
  
  async notifySaaSLead(leadName: string, feature: string, trialDaysLeft: number) {
    const priority = trialDaysLeft <= 3 ? 'high' : 'normal';
    
    return await notifyLeadAttention({
      site_id: this.siteId,
      names: [leadName],
      user_message: `I have questions about the ${feature} feature before my trial ends`,
      system_message: `SaaS trial user - ${trialDaysLeft} days remaining`,
      channel: 'chat',
      priority,
      additional_data: {
        context: 'saas',
        trial_days_left: trialDaysLeft,
        feature_interest: feature,
        conversion_opportunity: trialDaysLeft <= 7
      }
    });
  }
  
  async notifyServiceLead(leadName: string, serviceType: string, urgency: boolean = false) {
    return await notifyLeadAttention({
      site_id: this.siteId,
      names: [leadName],
      system_message: `Service inquiry for ${serviceType}`,
      channel: 'form',
      priority: urgency ? 'urgent' : 'normal',
      additional_data: {
        context: 'services',
        service_type: serviceType,
        requires_consultation: true
      }
    });
  }
}

// Ejemplo de uso del servicio
export async function serviceUsageExample() {
  console.log('🏢 Ejemplo: Uso del servicio por contexto');
  
  const ecommerceService = new LeadAttentionService('550e8400-e29b-41d4-a716-446655440000');
  const saasService = new LeadAttentionService('661e8400-e29b-41d4-a716-446655440001');
  
  try {
    // E-commerce
    await ecommerceService.notifyEcommerceLead(
      'John Doe',
      'My order #12345 hasn\'t arrived and it was supposed to be here yesterday',
      'high'
    );
    
    // SaaS
    await saasService.notifySaaSLead(
      'Jane Smith',
      'advanced analytics',
      2 // 2 days left in trial
    );
    
    console.log('✅ Notificaciones de servicios enviadas');
  } catch (error) {
    console.error('❌ Error en notificaciones de servicios:', error);
  }
}

// Función para ejecutar todos los ejemplos
export async function runAllLeadAttentionExamples() {
  console.log('🚀 Ejecutando todos los ejemplos de Lead Attention API...\n');
  
  try {
    await basicLeadAttentionExample();
    console.log('');
    
    await multipleLeadsAttentionExample();
    console.log('');
    
    await urgentWhatsAppAttentionExample();
    console.log('');
    
    await phoneCallAttentionExample();
    console.log('');
    
    await liveChatAttentionExample();
    console.log('');
    
    await eventLeadsBatchNotification();
    console.log('');
    
    await handleSiteWithoutChannelsExample();
    console.log('');
    
    await serviceUsageExample();
    console.log('');
    
    console.log('✅ Todos los ejemplos ejecutados exitosamente');
  } catch (error) {
    console.error('❌ Error ejecutando ejemplos:', error);
  }
}

// Export por defecto para usar fácilmente
const leadAttentionExamples = {
  notifyLeadAttention,
  basicLeadAttentionExample,
  multipleLeadsAttentionExample,
  urgentWhatsAppAttentionExample,
  phoneCallAttentionExample,
  liveChatAttentionExample,
  eventLeadsBatchNotification,
  handleLeadAttentionWithRetry,
  handleSiteWithoutChannelsExample,
  LeadAttentionService,
  serviceUsageExample,
  runAllLeadAttentionExamples
};

export default leadAttentionExamples; 