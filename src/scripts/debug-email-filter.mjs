/**
 * Script de debugging para comprehensiveEmailFilter
 * Simula exactamente el escenario real sin API keys
 */

import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';

// Cargar variables de entorno desde .env.local
config({ path: '.env.local' });

// Configuración de Supabase
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

console.log('[DEBUG] 🔧 Variables de entorno:', {
  supabaseUrl: supabaseUrl ? 'PRESENT' : 'MISSING',
  supabaseKey: supabaseKey ? 'PRESENT' : 'MISSING'
});

if (!supabaseUrl || !supabaseKey) {
  console.error('[DEBUG] ❌ Faltan variables de entorno de Supabase');
  console.error('[DEBUG] NEXT_PUBLIC_SUPABASE_URL:', supabaseUrl || 'UNDEFINED');
  console.error('[DEBUG] SUPABASE_SERVICE_ROLE_KEY:', supabaseKey ? 'DEFINED' : 'UNDEFINED');
  process.exit(1);
}

const supabaseAdmin = createClient(supabaseUrl, supabaseKey);

// Datos reales del usuario
const REAL_DATA = {
  site_id: "9be0a6a2-5567-41bf-ad06-cb4014f0faf2",
  limit: 20,
  user_id: "541396e1-a904-4a81-8cbf-0ca4e3b8b2b4",
  analysis_type: "commercial_opportunity",
  since_date: "2025-07-28T20:39:29.858Z"
};

// Test específico de consulta a leads (CON TIMEOUT)
async function testLeadsQueryWithTimeout(siteId, emailAddresses, timeoutMs = 10000) {
  console.log('\n[DEBUG] 🧪 === TEST CONSULTA LEADS (CON TIMEOUT) ===');
  console.log(`[DEBUG] 🔧 Site ID: ${siteId}`);
  console.log(`[DEBUG] 🔧 Email addresses: ${emailAddresses.length} direcciones`);
  console.log(`[DEBUG] 🔧 Timeout: ${timeoutMs}ms`);
  console.log(`[DEBUG] 🔧 Direcciones:`, emailAddresses.slice(0, 5));
  
  const startTime = Date.now();
  
  try {
    console.log(`[DEBUG] 🔧 Ejecutando consulta a tabla leads...`);
    
    // Crear promesa de timeout
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('TIMEOUT_LEADS_QUERY')), timeoutMs);
    });
    
    // Crear promesa de consulta
    const queryPromise = supabaseAdmin
      .from('leads')
      .select('id, email, name, assignee_id, status, created_at')
      .eq('site_id', siteId)
      .is('assignee_id', null)
      .in('email', emailAddresses);
    
    // Ejecutar con timeout
    const { data: aiLeads, error } = await Promise.race([queryPromise, timeoutPromise]);
    
    const endTime = Date.now();
    console.log(`[DEBUG] ⏱️ Consulta leads completada en ${endTime - startTime}ms`);
    
    if (error) {
      console.error(`[DEBUG] ❌ Error en consulta leads:`, error);
      return false;
    }
    
    console.log(`[DEBUG] ✅ Leads encontrados: ${aiLeads?.length || 0}`);
    if (aiLeads && aiLeads.length > 0) {
      console.log(`[DEBUG] 📊 Primeros leads:`, aiLeads.slice(0, 3));
    }
    
    return true;
  } catch (error) {
    const endTime = Date.now();
    if (error.message === 'TIMEOUT_LEADS_QUERY') {
      console.error(`[DEBUG] ⏰ TIMEOUT en consulta leads después de ${endTime - startTime}ms`);
      console.error(`[DEBUG] 🚨 LA CONSULTA A TABLA LEADS SE ESTÁ COLGANDO`);
    } else {
      console.error(`[DEBUG] ❌ Exception en consulta leads (${endTime - startTime}ms):`, error.message);
    }
    return false;
  }
}

// Test específico de consulta a synced_objects (CON TIMEOUT)
async function testSyncedObjectsQueryWithTimeout(siteId, emailIds, timeoutMs = 10000) {
  console.log('\n[DEBUG] 🧪 === TEST CONSULTA SYNCED_OBJECTS (CON TIMEOUT) ===');
  console.log(`[DEBUG] 🔧 Site ID: ${siteId}`);
  console.log(`[DEBUG] 🔧 Email IDs: ${emailIds.length} IDs`);
  console.log(`[DEBUG] 🔧 Timeout: ${timeoutMs}ms`);
  console.log(`[DEBUG] 🔧 IDs:`, emailIds.slice(0, 5));
  
  const startTime = Date.now();
  
  try {
    console.log(`[DEBUG] 🔧 Ejecutando consulta a tabla synced_objects...`);
    
    // Crear promesa de timeout
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('TIMEOUT_SYNCED_OBJECTS_QUERY')), timeoutMs);
    });
    
    // Crear promesa de consulta
    const queryPromise = supabaseAdmin
      .from('synced_objects')
      .select('external_id')
      .eq('site_id', siteId)
      .eq('object_type', 'email')
      .in('external_id', emailIds);
    
    // Ejecutar con timeout
    const { data: existingObjects, error } = await Promise.race([queryPromise, timeoutPromise]);
    
    const endTime = Date.now();
    console.log(`[DEBUG] ⏱️ Consulta synced_objects completada en ${endTime - startTime}ms`);
    
    if (error) {
      console.error(`[DEBUG] ❌ Error en consulta synced_objects:`, error);
      return false;
    }
    
    console.log(`[DEBUG] ✅ Objetos sincronizados encontrados: ${existingObjects?.length || 0}`);
    if (existingObjects && existingObjects.length > 0) {
      console.log(`[DEBUG] 📊 Primeros objetos:`, existingObjects.slice(0, 3));
    }
    
    return true;
  } catch (error) {
    const endTime = Date.now();
    if (error.message === 'TIMEOUT_SYNCED_OBJECTS_QUERY') {
      console.error(`[DEBUG] ⏰ TIMEOUT en consulta synced_objects después de ${endTime - startTime}ms`);
      console.error(`[DEBUG] 🚨 LA CONSULTA A TABLA SYNCED_OBJECTS SE ESTÁ COLGANDO`);
    } else {
      console.error(`[DEBUG] ❌ Exception en consulta synced_objects (${endTime - startTime}ms):`, error.message);
    }
    return false;
  }
}

// Test de consulta a settings (para verificar conectividad general)
async function testSettingsQuery(siteId) {
  console.log('\n[DEBUG] 🧪 === TEST CONSULTA SETTINGS ===');
  
  const startTime = Date.now();
  
  try {
    console.log(`[DEBUG] 🔧 Consultando settings para sitio: ${siteId}`);
    
    const { data: settings, error } = await supabaseAdmin
      .from('settings')
      .select('channels')
      .eq('site_id', siteId)
      .single();
    
    const endTime = Date.now();
    console.log(`[DEBUG] ⏱️ Consulta settings completada en ${endTime - startTime}ms`);
    
    if (error) {
      console.error(`[DEBUG] ❌ Error en consulta settings:`, error);
      return null;
    }
    
    console.log(`[DEBUG] ✅ Settings encontrados:`, {
      email: settings?.channels?.email?.email,
      provider: settings?.channels?.email?.provider,
      aliases: settings?.channels?.email?.aliases,
      hasEmail: !!settings?.channels?.email
    });
    
    return settings;
  } catch (error) {
    const endTime = Date.now();
    console.error(`[DEBUG] ❌ Exception en consulta settings (${endTime - startTime}ms):`, error.message);
    return null;
  }
}

// Test principal
async function debugDatabaseQueries() {
  console.log('\n🚀 === INICIANDO DEBUG DATABASE QUERIES ===\n');
  
  const { site_id: siteId } = REAL_DATA;
  
  try {
    // 1. Test básico de conectividad con settings
    const settings = await testSettingsQuery(siteId);
    if (!settings) {
      console.log('[DEBUG] ❌ No se pudo obtener settings - revisando conectividad');
      return;
    }
    
    // 2. Simular direcciones de email reales (volumen representativo)
    const emailAddresses = [
      'customer1@testcompany.com',
      'lead@potential.com', 
      'info@business.com',
      'contact@startup.com',
      'sales@enterprise.com',
      'support@client.com',
      'admin@organization.com',
      'user@example.com',
      'inquiry@company.com',
      'partner@vendor.com',
      'prospect@lead.com',
      'client@customer.com',
      'team@business.com',
      'hello@startup.com',
      'contact@enterprise.com',
      'info@organization.com',
      'sales@potential.com',
      'support@testcompany.com',
      'admin@client.com',
      'user@lead.com'
    ];
    
    console.log(`[DEBUG] 📧 Testing con ${emailAddresses.length} direcciones de email`);
    
    // 3. Test consulta leads (CON TIMEOUT AGRESIVO)
    console.log(`[DEBUG] 🎯 Probando consulta LEADS con timeout de 10 segundos...`);
    const leadsOk = await testLeadsQueryWithTimeout(siteId, emailAddresses, 10000);
    
    // 4. Simular IDs de emails reales
    const emailIds = [
      'email_001', 'email_002', 'email_003', 'email_004', 'email_005',
      'email_006', 'email_007', 'email_008', 'email_009', 'email_010',
      'email_011', 'email_012', 'email_013', 'email_014', 'email_015',
      'email_016', 'email_017', 'email_018', 'email_019', 'email_020'
    ];
    
    console.log(`[DEBUG] 🆔 Testing con ${emailIds.length} IDs de email`);
    
    // 5. Test consulta synced_objects (CON TIMEOUT AGRESIVO)
    console.log(`[DEBUG] 🎯 Probando consulta SYNCED_OBJECTS con timeout de 10 segundos...`);
    const syncedOk = await testSyncedObjectsQueryWithTimeout(siteId, emailIds, 10000);
    
    // 6. Diagnóstico final
    console.log('\n[DEBUG] 📊 === DIAGNÓSTICO FINAL ===');
    
    if (leadsOk && syncedOk) {
      console.log('[DEBUG] ✅ Ambas consultas completaron exitosamente');
      console.log('[DEBUG] 💡 El problema debe estar en el volumen real de datos o en el entorno de producción');
    } else if (!leadsOk) {
      console.log('[DEBUG] ❌ PROBLEMA IDENTIFICADO: La consulta a tabla LEADS se está colgando');
      console.log('[DEBUG] 💡 Soluciones sugeridas:');
      console.log('[DEBUG]    - Agregar índice en (site_id, assignee_id, email)');
      console.log('[DEBUG]    - Limitar el tamaño del array IN()');
      console.log('[DEBUG]    - Agregar timeout específico a la consulta');
    } else if (!syncedOk) {
      console.log('[DEBUG] ❌ PROBLEMA IDENTIFICADO: La consulta a tabla SYNCED_OBJECTS se está colgando');
      console.log('[DEBUG] 💡 Soluciones sugeridas:');
      console.log('[DEBUG]    - Agregar índice en (site_id, object_type, external_id)');
      console.log('[DEBUG]    - Usar paginación para consultas grandes');
      console.log('[DEBUG]    - Agregar timeout específico a la consulta');
    }
    
  } catch (error) {
    console.error('\n[DEBUG] ❌ === ERROR GENERAL ===');
    console.error('[DEBUG] Error:', error.message);
    console.error('[DEBUG] Stack:', error.stack);
  }
}

// Ejecutar el debug
debugDatabaseQueries()
  .then(() => {
    console.log('\n[DEBUG] 🏁 Debug completado');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n[DEBUG] 💥 Error fatal:', error);
    process.exit(1);
  }); 