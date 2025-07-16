/**
 * Ejemplo de uso del servicio de notificación de leads nuevos sin asignar
 */

// Tipos para mejorar type safety
type Priority = 'low' | 'normal' | 'high' | 'urgent';

interface SiteCheckResult {
  siteId: string;
  siteName?: string;
  unassignedLeads?: number;
  notificationSent?: boolean;
  hoursRemaining?: number;
  error?: string;
}

// Ejemplo 1: Verificación diaria automática de leads sin asignar
export async function dailyLeadsCheck(siteId: string) {
  console.log('🔄 Ejecutando verificación diaria de leads sin asignar...');
  
  try {
    const response = await fetch('/api/notifications/newLeadsAlert', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        site_id: siteId,
        priority: 'normal',
        hours_until_auto_prospect: 48,
        include_lead_details: true,
        max_leads_to_display: 20
      })
    });

    const result = await response.json();

    if (result.success) {
      if (result.data.notification_sent) {
        console.log(`✅ Notificación enviada: ${result.data.total_unassigned_leads} leads sin asignar`);
        console.log(`📧 Emails enviados: ${result.data.emails_sent}`);
        console.log(`👥 Team members notificados: ${result.data.team_members_notified}`);
      } else {
        console.log('✨ Excelente! No hay leads sin asignar');
      }
    } else {
      console.error('❌ Error en verificación:', result.error);
    }
    
    return result;
  } catch (error) {
    console.error('❌ Error ejecutando verificación diaria:', error);
    throw error;
  }
}

// Ejemplo 2: Alerta urgente para leads próximos al auto-prospecting
export async function urgentLeadsAlert(siteId: string) {
  console.log('🚨 Ejecutando alerta urgente de leads sin asignar...');
  
  try {
    const response = await fetch('/api/notifications/newLeadsAlert', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        site_id: siteId,
        priority: 'urgent',
        hours_until_auto_prospect: 6, // Solo 6 horas restantes
        include_lead_details: true,
        max_leads_to_display: 30 // Mostrar más leads en urgente
      })
    });

    const result = await response.json();

    if (result.success && result.data.notification_sent) {
      console.log(`🚨 ALERTA URGENTE: ${result.data.total_unassigned_leads} leads serán auto-prospectados en ${result.data.hours_until_auto_prospect} horas`);
      
      // Mostrar preview de leads si está disponible
      if (result.data.leads_preview) {
        console.log('📋 Leads sin asignar:');
        result.data.leads_preview.forEach((lead: any, index: number) => {
          console.log(`  ${index + 1}. ${lead.name} (${lead.email}) - ${lead.segment || 'Sin segmento'}`);
        });
      }
    } else if (result.success && !result.data.notification_sent) {
      console.log('✅ No hay leads urgentes sin asignar');
    } else {
      console.error('❌ Error en alerta urgente:', result.error);
    }
    
    return result;
  } catch (error) {
    console.error('❌ Error ejecutando alerta urgente:', error);
    throw error;
  }
}

// Ejemplo 3: Resumen simple sin detalles de leads (para reportes ejecutivos)
export async function executiveSummary(siteId: string) {
  console.log('📊 Generando resumen ejecutivo de leads sin asignar...');
  
  try {
    const response = await fetch('/api/notifications/newLeadsAlert', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        site_id: siteId,
        priority: 'low',
        hours_until_auto_prospect: 72, // 3 días
        include_lead_details: false, // Solo números, no detalles
        max_leads_to_display: 5
      })
    });

    const result = await response.json();

    if (result.success) {
      console.log(`📈 Resumen ejecutivo para sitio ${result.data.site_info?.name || siteId}:`);
      console.log(`   • Leads sin asignar: ${result.data.total_unassigned_leads}`);
      console.log(`   • Auto-prospecting en: ${result.data.hours_until_auto_prospect} horas`);
      console.log(`   • Notificación enviada: ${result.data.notification_sent ? 'Sí' : 'No'}`);
    } else {
      console.error('❌ Error en resumen ejecutivo:', result.error);
    }
    
    return result;
  } catch (error) {
    console.error('❌ Error generando resumen ejecutivo:', error);
    throw error;
  }
}

// Ejemplo 4: Monitoreo por horas para múltiples sitios
export async function multiSiteHourlyCheck(siteIds: string[]): Promise<SiteCheckResult[]> {
  console.log(`⏰ Ejecutando verificación horaria para ${siteIds.length} sitios...`);
  
  const results: SiteCheckResult[] = [];
  
  for (const siteId of siteIds) {
    try {
      console.log(`🔍 Verificando sitio: ${siteId}`);
      
      const response = await fetch('/api/notifications/newLeadsAlert', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          site_id: siteId,
          priority: 'high',
          hours_until_auto_prospect: 24, // Revisar leads que entran a auto-prospecting en 24h
          include_lead_details: true,
          max_leads_to_display: 15
        })
      });

      const result = await response.json();
      
      if (result.success) {
        const summary: SiteCheckResult = {
          siteId,
          siteName: result.data.site_info?.name || 'Sitio desconocido',
          unassignedLeads: result.data.total_unassigned_leads,
          notificationSent: result.data.notification_sent,
          hoursRemaining: result.data.hours_until_auto_prospect
        };
        
        results.push(summary);
        
        if (summary.unassignedLeads && summary.unassignedLeads > 0) {
          console.log(`⚠️  ${summary.siteName}: ${summary.unassignedLeads} leads sin asignar`);
        } else {
          console.log(`✅ ${summary.siteName}: Sin leads pendientes`);
        }
      } else {
        console.error(`❌ Error en sitio ${siteId}:`, result.error);
        results.push({
          siteId,
          error: result.error?.message || 'Error desconocido'
        });
      }
    } catch (error) {
      console.error(`❌ Error procesando sitio ${siteId}:`, error);
      results.push({
        siteId,
        error: 'Error de conexión'
      });
    }
    
    // Pequeña pausa entre sitios para no sobrecargar
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  // Resumen final
  const sitesWithLeads = results.filter(r => !r.error && (r.unassignedLeads ?? 0) > 0).length;
  const totalLeads = results
    .filter(r => !r.error)
    .reduce((sum, r) => sum + (r.unassignedLeads ?? 0), 0);
  
  console.log('\n📊 Resumen de verificación horaria:');
  console.log(`   • Sitios verificados: ${siteIds.length}`);
  console.log(`   • Sitios con leads sin asignar: ${sitesWithLeads}`);
  console.log(`   • Total de leads sin asignar: ${totalLeads}`);
  
  return results;
}

// Ejemplo 5: Configuración para diferentes tipos de negocio
export async function businessTypeAlerts() {
  console.log('🏢 Configurando alertas según tipo de negocio...');
  
  // E-commerce: Alertas más frecuentes debido a alta rotación
  const ecommerceConfig = {
    priority: 'high' as const,
    hours_until_auto_prospect: 12, // Más agresivo
    include_lead_details: true,
    max_leads_to_display: 25
  };
  
  // B2B Enterprise: Más tiempo para evaluación humana
  const enterpriseConfig = {
    priority: 'normal' as const,
    hours_until_auto_prospect: 72, // 3 días
    include_lead_details: true,
    max_leads_to_display: 15
  };
  
  // Servicios locales: Tiempo medio
  const localServicesConfig = {
    priority: 'normal' as const,
    hours_until_auto_prospect: 24, // 1 día
    include_lead_details: true,
    max_leads_to_display: 20
  };
  
  // SaaS: Equilibrio entre volumen y calidad
  const saasConfig = {
    priority: 'high' as const,
    hours_until_auto_prospect: 48, // 2 días
    include_lead_details: true,
    max_leads_to_display: 30
  };
  
  return {
    ecommerce: ecommerceConfig,
    enterprise: enterpriseConfig,
    localServices: localServicesConfig,
    saas: saasConfig
  };
}

// Ejemplo 6: Integración con webhook para automatización
export async function webhookIntegration(webhookPayload: any) {
  console.log('🔗 Procesando webhook para nueva notificación de leads...');
  
  try {
    // Extraer información del webhook
    const { site_id, trigger_type, priority_override } = webhookPayload;
    
         // Determinar configuración según el trigger
     let config = {
       site_id,
       priority: 'normal' as Priority,
       hours_until_auto_prospect: 48,
       include_lead_details: true,
       max_leads_to_display: 20
     };
    
         // Ajustar configuración según el tipo de trigger
     switch (trigger_type) {
       case 'high_value_lead_detected':
         config.priority = 'urgent' as Priority;
         config.hours_until_auto_prospect = 6;
         config.max_leads_to_display = 10;
         break;
         
       case 'weekend_accumulation':
         config.priority = 'high' as Priority;
         config.hours_until_auto_prospect = 24;
         config.max_leads_to_display = 30;
         break;
         
       case 'monthly_review':
         config.priority = 'low' as Priority;
         config.hours_until_auto_prospect = 168; // 1 semana
         config.include_lead_details = false;
         break;
     }
    
    // Aplicar override de prioridad si se proporciona
    if (priority_override) {
      config.priority = priority_override;
    }
    
    console.log(`📤 Enviando notificación con config:`, config);
    
    const response = await fetch('/api/notifications/newLeadsAlert', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(config)
    });

    const result = await response.json();
    
    if (result.success) {
      console.log(`✅ Webhook procesado exitosamente para ${trigger_type}`);
      return {
        success: true,
        trigger_type,
        leads_found: result.data.total_unassigned_leads,
        notification_sent: result.data.notification_sent
      };
    } else {
      console.error(`❌ Error procesando webhook:`, result.error);
      return {
        success: false,
        error: result.error
      };
    }
  } catch (error) {
    console.error('❌ Error en webhook integration:', error);
    return {
      success: false,
      error: 'Webhook processing failed'
    };
  }
}

// Ejemplo 7: Función de utilidad para determinar configuración automática
export function getConfigForSite(siteMetrics: {
  leadVelocity: number; // leads por día
  businessType: string;
  teamSize: number;
  currentUnassignedCount: number;
}) {
  const { leadVelocity, businessType, teamSize, currentUnassignedCount } = siteMetrics;
  
  let priority: 'low' | 'normal' | 'high' | 'urgent' = 'normal';
  let hoursUntilAutoProspect = 48;
  let maxLeadsToDisplay = 20;
  
  // Ajustar por velocidad de leads
  if (leadVelocity > 50) {
    // Alto volumen
    priority = 'high';
    hoursUntilAutoProspect = 12;
    maxLeadsToDisplay = 30;
  } else if (leadVelocity > 20) {
    // Volumen medio
    priority = 'normal';
    hoursUntilAutoProspect = 24;
    maxLeadsToDisplay = 25;
  } else {
    // Bajo volumen
    priority = 'low';
    hoursUntilAutoProspect = 72;
    maxLeadsToDisplay = 15;
  }
  
  // Ajustar por tipo de negocio
  if (businessType === 'ecommerce') {
    hoursUntilAutoProspect = Math.min(hoursUntilAutoProspect, 12);
    priority = priority === 'low' ? 'normal' : 'high';
  } else if (businessType === 'enterprise') {
    hoursUntilAutoProspect = Math.max(hoursUntilAutoProspect, 48);
  }
  
  // Ajustar por tamaño del equipo
  if (teamSize <= 2) {
    // Equipo pequeño - más tiempo para revisar
    hoursUntilAutoProspect *= 1.5;
  } else if (teamSize >= 10) {
    // Equipo grande - menos tiempo
    hoursUntilAutoProspect *= 0.75;
  }
  
  // Urgencia por acumulación actual
  if (currentUnassignedCount > 50) {
    priority = 'urgent';
    hoursUntilAutoProspect = Math.min(hoursUntilAutoProspect, 6);
  } else if (currentUnassignedCount > 20) {
    priority = priority === 'low' ? 'normal' : 'high';
  }
  
  return {
    priority,
    hours_until_auto_prospect: Math.round(hoursUntilAutoProspect),
    include_lead_details: true,
    max_leads_to_display: Math.min(maxLeadsToDisplay, 50)
  };
}

// Ejemplo 8: Flujo completo de monitoreo
export async function completeMonitoringFlow() {
  console.log('🔄 Iniciando flujo completo de monitoreo de leads...');
  
  const siteIds = [
    'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
  ];
  
  try {
    // 1. Verificación general
    console.log('📊 Paso 1: Verificación general de sitios...');
    const generalCheck = await multiSiteHourlyCheck(siteIds);
    
         // 2. Identificar sitios que necesitan atención urgente
     const urgentSites = generalCheck.filter(site => 
       !site.error && (site.unassignedLeads ?? 0) > 10
     );
    
    if (urgentSites.length > 0) {
      console.log(`🚨 Paso 2: Enviando alertas urgentes para ${urgentSites.length} sitios...`);
      
      for (const site of urgentSites) {
        await urgentLeadsAlert(site.siteId);
        // Pausa entre alertas urgentes
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    // 3. Resúmenes ejecutivos para todos los sitios
    console.log('📈 Paso 3: Generando resúmenes ejecutivos...');
    const executiveSummaries = await Promise.all(
      siteIds.map(siteId => executiveSummary(siteId))
    );
    
    // 4. Reporte final
    console.log('\n🎯 REPORTE FINAL DE MONITOREO');
    console.log('================================');
    
         const totalSites = siteIds.length;
     const sitesWithIssues = generalCheck.filter(s => !s.error && (s.unassignedLeads ?? 0) > 0).length;
     const totalUnassigned = generalCheck
       .filter(s => !s.error)
       .reduce((sum, s) => sum + (s.unassignedLeads ?? 0), 0);
    
    console.log(`📊 Sitios monitoreados: ${totalSites}`);
    console.log(`⚠️  Sitios con leads sin asignar: ${sitesWithIssues}`);
    console.log(`📈 Total de leads sin asignar: ${totalUnassigned}`);
    console.log(`🚨 Sitios con alerta urgente: ${urgentSites.length}`);
    
    return {
      totalSites,
      sitesWithIssues,
      totalUnassigned,
      urgentSites: urgentSites.length,
      generalCheck,
      executiveSummaries
    };
    
  } catch (error) {
    console.error('❌ Error en flujo de monitoreo:', error);
    throw error;
  }
}

// Exportar todas las funciones para uso fácil
export const NewLeadsAlertExamples = {
  dailyLeadsCheck,
  urgentLeadsAlert,
  executiveSummary,
  multiSiteHourlyCheck,
  businessTypeAlerts,
  webhookIntegration,
  getConfigForSite,
  completeMonitoringFlow
}; 