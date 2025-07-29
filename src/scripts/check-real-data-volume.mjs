/**
 * Script para verificar el volumen real de datos que está causando el timeout
 */

import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';

// Cargar variables de entorno
config({ path: '.env.local' });

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const SITE_ID = "9be0a6a2-5567-41bf-ad06-cb4014f0faf2";

async function checkDataVolume() {
  console.log('\n🔍 === VERIFICANDO VOLUMEN DE DATOS REALES ===\n');
  
  try {
    // 1. Contar leads totales para el sitio
    console.log('[VOLUME] 📊 Contando leads totales...');
    const { count: totalLeads, error: leadsError } = await supabaseAdmin
      .from('leads')
      .select('*', { count: 'exact', head: true })
      .eq('site_id', SITE_ID);
    
    if (leadsError) {
      console.error('[VOLUME] ❌ Error contando leads:', leadsError);
    } else {
      console.log(`[VOLUME] 📈 Total leads en el sitio: ${totalLeads}`);
    }
    
    // 2. Contar leads con assignee_id = null (los que se consultan)
    console.log('[VOLUME] 🤖 Contando leads asignados a IA...');
    const { count: aiLeads, error: aiLeadsError } = await supabaseAdmin
      .from('leads')
      .select('*', { count: 'exact', head: true })
      .eq('site_id', SITE_ID)
      .is('assignee_id', null);
    
    if (aiLeadsError) {
      console.error('[VOLUME] ❌ Error contando leads IA:', aiLeadsError);
    } else {
      console.log(`[VOLUME] 🤖 Leads asignados a IA: ${aiLeads}`);
    }
    
    // 3. Contar objetos sincronizados tipo email
    console.log('[VOLUME] 📧 Contando objetos sincronizados (emails)...');
    const { count: syncedEmails, error: syncedError } = await supabaseAdmin
      .from('synced_objects')
      .select('*', { count: 'exact', head: true })
      .eq('site_id', SITE_ID)
      .eq('object_type', 'email');
    
    if (syncedError) {
      console.error('[VOLUME] ❌ Error contando synced_objects:', syncedError);
    } else {
      console.log(`[VOLUME] 📧 Emails ya sincronizados: ${syncedEmails}`);
    }
    
    // 4. Obtener sample de direcciones de email reales de leads
    console.log('[VOLUME] 📋 Obteniendo sample de emails de leads...');
    const { data: sampleLeads, error: sampleError } = await supabaseAdmin
      .from('leads')
      .select('email')
      .eq('site_id', SITE_ID)
      .is('assignee_id', null)
      .limit(50);
    
    if (sampleError) {
      console.error('[VOLUME] ❌ Error obteniendo sample:', sampleError);
    } else {
      const emailAddresses = sampleLeads?.map(lead => lead.email).filter(Boolean) || [];
      console.log(`[VOLUME] 📋 Sample de ${emailAddresses.length} direcciones de email reales`);
      console.log(`[VOLUME] 📋 Primeras 10:`, emailAddresses.slice(0, 10));
      
      // 5. PROBAR consulta con emails reales (la que se está colgando)
      if (emailAddresses.length > 0) {
        console.log(`\n[VOLUME] 🎯 === PROBANDO CONSULTA REAL CON ${emailAddresses.length} EMAILS ===`);
        
        const startTime = Date.now();
        try {
          const { data: realLeads, error: realError } = await supabaseAdmin
            .from('leads')
            .select('id, email, name, assignee_id, status, created_at')
            .eq('site_id', SITE_ID)
            .is('assignee_id', null)
            .in('email', emailAddresses);
          
          const endTime = Date.now();
          console.log(`[VOLUME] ⏱️ Consulta con emails reales completada en ${endTime - startTime}ms`);
          console.log(`[VOLUME] ✅ Resultados encontrados: ${realLeads?.length || 0}`);
          
        } catch (error) {
          const endTime = Date.now();
          console.error(`[VOLUME] ❌ ERROR en consulta real (${endTime - startTime}ms):`, error.message);
        }
      }
    }
    
    // 6. SIMULAR el volumen real que podría estar llegando del EmailService
    console.log(`\n[VOLUME] 🔥 === SIMULANDO VOLUMEN ALTO (como EmailService real) ===`);
    
    // Simular 20 emails (limit típico) con IDs únicos
    const emailIds = [];
    for (let i = 1; i <= 20; i++) {
      emailIds.push(`real_email_${Date.now()}_${i}`);
    }
    
    console.log(`[VOLUME] 📧 Probando consulta synced_objects con ${emailIds.length} IDs únicos...`);
    const startTime2 = Date.now();
    
    try {
      const { data: existingObjects, error: existingError } = await supabaseAdmin
        .from('synced_objects')
        .select('external_id')
        .eq('site_id', SITE_ID)
        .eq('object_type', 'email')
        .in('external_id', emailIds);
      
      const endTime2 = Date.now();
      console.log(`[VOLUME] ⏱️ Consulta synced_objects con IDs únicos completada en ${endTime2 - startTime2}ms`);
      console.log(`[VOLUME] ✅ Objetos existentes encontrados: ${existingObjects?.length || 0}`);
      
    } catch (error) {
      const endTime2 = Date.now();
      console.error(`[VOLUME] ❌ ERROR en consulta synced_objects (${endTime2 - startTime2}ms):`, error.message);
    }
    
    // 7. RESUMEN Y DIAGNÓSTICO
    console.log(`\n[VOLUME] 📊 === RESUMEN DIAGNÓSTICO ===`);
    console.log(`[VOLUME] 📈 Total leads: ${totalLeads}`);
    console.log(`[VOLUME] 🤖 Leads IA: ${aiLeads}`);
    console.log(`[VOLUME] 📧 Emails sincronizados: ${syncedEmails}`);
    
    if (totalLeads > 10000) {
      console.log(`[VOLUME] 🚨 PROBLEMA POTENCIAL: Muchos leads (${totalLeads}) pueden hacer lenta la consulta`);
    }
    
    if (syncedEmails > 10000) {
      console.log(`[VOLUME] 🚨 PROBLEMA POTENCIAL: Muchos emails sincronizados (${syncedEmails}) pueden hacer lenta la consulta`);
    }
    
    if (aiLeads > 1000) {
      console.log(`[VOLUME] 🚨 PROBLEMA POTENCIAL: Muchos leads asignados a IA (${aiLeads}) pueden hacer lenta la consulta IN()`);
    }
    
  } catch (error) {
    console.error('\n[VOLUME] ❌ === ERROR GENERAL ===');
    console.error('[VOLUME] Error:', error.message);
  }
}

checkDataVolume()
  .then(() => {
    console.log('\n[VOLUME] 🏁 Verificación de volumen completada');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n[VOLUME] 💥 Error fatal:', error);
    process.exit(1);
  }); 