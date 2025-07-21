/**
 * Ejemplo de uso del endpoint de notificación de configuración de canales requerida
 * 
 * Este ejemplo muestra cómo usar el endpoint /api/notifications/channelsSetupRequired
 * para notificar a los team members cuando un sitio necesita configurar canales
 * de comunicación para habilitar la prospección automática.
 */

// Interfaz para la respuesta del endpoint
interface ChannelsSetupNotificationResponse {
  success: boolean;
  message?: string;
  data: {
    site_id: string;
    channels_configured: boolean;
    missing_channels: string[];
    configured_channels: string[];
    notification_sent: boolean;
    team_members_notified?: number;
    total_team_members?: number;
    emails_sent?: number;
    email_errors?: number;
    sent_at?: string;
    team_members_found?: number;
  };
  error?: {
    code: string;
    message: string;
    details?: any[];
  };
}

// Función de ejemplo para enviar notificación
export async function sendChannelsSetupNotification(siteId: string): Promise<ChannelsSetupNotificationResponse> {
  try {
    console.log(`📧 Enviando notificación de configuración de canales para sitio: ${siteId}`);
    
    const response = await fetch('/api/notifications/channelsSetupRequired', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        site_id: siteId
      })
    });

    const data: ChannelsSetupNotificationResponse = await response.json();

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${data.error?.message || 'Unknown error'}`);
    }

    return data;
  } catch (error) {
    console.error('Error enviando notificación de configuración de canales:', error);
    throw error;
  }
}

// Función de ejemplo para verificar múltiples sitios
export async function checkMultipleSitesChannelsSetup(siteIds: string[]): Promise<void> {
  console.log(`🔍 Verificando configuración de canales para ${siteIds.length} sitios...`);
  
  const results: Array<{
    siteId: string;
    success: boolean;
    channels_configured?: boolean;
    notification_sent?: boolean;
    missing_channels?: string[];
    configured_channels?: string[];
    team_members_notified?: number;
    error?: string;
  }> = [];
  
  for (const siteId of siteIds) {
    try {
      const result = await sendChannelsSetupNotification(siteId);
      results.push({
        siteId,
        success: true,
        channels_configured: result.data.channels_configured,
        notification_sent: result.data.notification_sent,
        missing_channels: result.data.missing_channels,
        configured_channels: result.data.configured_channels,
        team_members_notified: result.data.team_members_notified
      });
      
      // Log del resultado
      if (result.data.channels_configured) {
        console.log(`✅ Sitio ${siteId}: Canales configurados - ${result.data.configured_channels.join(', ')}`);
      } else if (result.data.notification_sent) {
        console.log(`📧 Sitio ${siteId}: Notificación enviada a ${result.data.team_members_notified} team members`);
        console.log(`   Canales faltantes: ${result.data.missing_channels.join(', ')}`);
      } else {
        console.log(`⚠️ Sitio ${siteId}: Sin team members para notificar`);
      }
      
    } catch (error) {
      console.error(`❌ Error en sitio ${siteId}:`, error);
      results.push({
        siteId,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
    
    // Pequeña pausa entre requests para evitar rate limiting
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  // Resumen final
  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  const notificationsSent = results.filter(r => r.success && r.notification_sent).length;
  const alreadyConfigured = results.filter(r => r.success && r.channels_configured).length;
  
  console.log('\n📊 Resumen de verificación de canales:');
  console.log(`   Total sitios procesados: ${results.length}`);
  console.log(`   Exitosos: ${successful}`);
  console.log(`   Fallidos: ${failed}`);
  console.log(`   Ya configurados: ${alreadyConfigured}`);
  console.log(`   Notificaciones enviadas: ${notificationsSent}`);
}

// Función para programar verificaciones periódicas
export function scheduleChannelsSetupCheck(siteIds: string[], intervalHours: number = 24): void {
  console.log(`⏰ Programando verificación de canales cada ${intervalHours} horas para ${siteIds.length} sitios`);
  
  // Verificación inicial
  checkMultipleSitesChannelsSetup(siteIds).catch(console.error);
  
  // Verificaciones periódicas
  const intervalMs = intervalHours * 60 * 60 * 1000;
  setInterval(() => {
    console.log('🔄 Ejecutando verificación periódica de canales...');
    checkMultipleSitesChannelsSetup(siteIds).catch(console.error);
  }, intervalMs);
}

// Ejemplos de uso

// Ejemplo 1: Verificar un sitio individual
async function example1() {
  try {
    const result = await sendChannelsSetupNotification('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
    console.log('Resultado:', result);
  } catch (error) {
    console.error('Error:', error);
  }
}

// Ejemplo 2: Verificar múltiples sitios
async function example2() {
  const siteIds = [
    'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    'b2c3d4e5-f6g7-8901-bcde-f23456789012',
    'c3d4e5f6-g7h8-9012-cdef-345678901234'
  ];
  
  await checkMultipleSitesChannelsSetup(siteIds);
}

// Ejemplo 3: Programar verificaciones automáticas cada 24 horas
function example3() {
  const siteIds = [
    'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    'b2c3d4e5-f6g7-8901-bcde-f23456789012'
  ];
  
  scheduleChannelsSetupCheck(siteIds, 24);
}

// Ejemplo 4: Manejo de diferentes respuestas
async function example4() {
  const siteId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
  
  try {
    const result = await sendChannelsSetupNotification(siteId);
    
    if (result.data.channels_configured) {
      console.log(`✅ Sitio ya tiene canales configurados: ${result.data.configured_channels.join(', ')}`);
    } else if (result.data.notification_sent) {
      console.log(`📧 Notificación enviada a ${result.data.team_members_notified} team members`);
      console.log(`❌ Canales faltantes: ${result.data.missing_channels.join(', ')}`);
      console.log(`✅ Canales configurados: ${result.data.configured_channels.join(', ')}`);
    } else {
      console.log(`⚠️ No se encontraron team members para notificar`);
    }
    
  } catch (error) {
    console.error('Error:', error);
  }
}

// Función utilitaria para usar en workflows automatizados
export async function validateSiteChannelsConfig(siteId: string): Promise<{
  isValid: boolean;
  missingChannels: string[];
  notificationSent: boolean;
}> {
  try {
    const result = await sendChannelsSetupNotification(siteId);
    
    return {
      isValid: result.data.channels_configured,
      missingChannels: result.data.missing_channels,
      notificationSent: result.data.notification_sent
    };
  } catch (error) {
    console.error(`Error validating channels for site ${siteId}:`, error);
    return {
      isValid: false,
      missingChannels: ['email', 'whatsapp'], // Asumir que faltan ambos en caso de error
      notificationSent: false
    };
  }
}

// Para usar en onboarding de nuevos sitios
export async function checkNewSiteSetup(siteId: string): Promise<void> {
  console.log(`🆕 Verificando configuración inicial del sitio: ${siteId}`);
  
  const validation = await validateSiteChannelsConfig(siteId);
  
  if (!validation.isValid) {
    console.log(`⚠️ Sitio ${siteId} requiere configuración de canales:`);
    console.log(`   Canales faltantes: ${validation.missingChannels.join(', ')}`);
    
    if (validation.notificationSent) {
      console.log(`✅ Notificación enviada a los team members`);
    } else {
      console.log(`❌ No se pudo enviar notificación (posiblemente sin team members)`);
    }
  } else {
    console.log(`✅ Sitio ${siteId} tiene canales configurados correctamente`);
  }
} 