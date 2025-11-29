/**
 * Script para verificar emails duplicados en la base de datos
 */

import { createClient } from '@supabase/supabase-js';

// Configurar Supabase
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('❌ Variables de entorno de Supabase no configuradas');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function checkDuplicateEmails() {
  console.log('🔍 Verificando emails duplicados en la base de datos...\n');

  try {
    // 1. Verificar synced_objects
    console.log('1️⃣ Verificando synced_objects...');
    const { data: syncedObjects, error: syncedError } = await supabase
      .from('synced_objects')
      .select('*')
      .eq('object_type', 'email')
      .order('created_at', { ascending: false })
      .limit(20);

    if (syncedError) {
      console.error('❌ Error consultando synced_objects:', syncedError);
      return;
    }

    console.log(`📊 Synced objects encontrados: ${syncedObjects.length}`);
    
    if (syncedObjects.length > 0) {
      console.log('\n📝 Últimos synced_objects:');
      syncedObjects.forEach((obj, index) => {
        console.log(`  ${index + 1}. external_id: ${obj.external_id}`);
        console.log(`     subject: ${obj.metadata?.subject || 'N/A'}`);
        console.log(`     from: ${obj.metadata?.from || 'N/A'}`);
        console.log(`     status: ${obj.status}`);
        console.log(`     created_at: ${obj.created_at}`);
        console.log(`     source: ${obj.metadata?.source || 'N/A'}`);
        console.log('');
      });
    }

    // 2. Verificar messages
    console.log('2️⃣ Verificando messages...');
    const { data: messages, error: messagesError } = await supabase
      .from('messages')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(20);

    if (messagesError) {
      console.error('❌ Error consultando messages:', messagesError);
      return;
    }

    console.log(`📊 Messages encontrados: ${messages.length}`);
    
    if (messages.length > 0) {
      console.log('\n📝 Últimos messages:');
      messages.forEach((msg, index) => {
        console.log(`  ${index + 1}. id: ${msg.id}`);
        console.log(`     subject: ${msg.subject || 'N/A'}`);
        console.log(`     from_email: ${msg.from_email || 'N/A'}`);
        console.log(`     to_email: ${msg.to_email || 'N/A'}`);
        console.log(`     created_at: ${msg.created_at}`);
        console.log(`     conversation_id: ${msg.conversation_id || 'N/A'}`);
        console.log('');
      });
    }

    // 3. Buscar posibles duplicados
    console.log('3️⃣ Buscando posibles duplicados...');
    
    // Agrupar por external_id en synced_objects
    const syncedByExternalId = {};
    syncedObjects.forEach(obj => {
      if (!syncedByExternalId[obj.external_id]) {
        syncedByExternalId[obj.external_id] = [];
      }
      syncedByExternalId[obj.external_id].push(obj);
    });

    const duplicates = Object.entries(syncedByExternalId)
      .filter(([externalId, objects]) => objects.length > 1)
      .map(([externalId, objects]) => ({ externalId, objects }));

    if (duplicates.length > 0) {
      console.log(`🚨 Encontrados ${duplicates.length} external_ids duplicados en synced_objects:`);
      duplicates.forEach(({ externalId, objects }) => {
        console.log(`  - external_id: ${externalId} (${objects.length} entradas)`);
        objects.forEach((obj, index) => {
          console.log(`    ${index + 1}. status: ${obj.status}, created_at: ${obj.created_at}`);
        });
      });
    } else {
      console.log('✅ No se encontraron external_ids duplicados en synced_objects');
    }

    // 4. Verificar emails recientes sin synced_objects
    console.log('\n4️⃣ Verificando emails recientes sin synced_objects...');
    
    // Buscar emails recientes en messages que no tienen synced_objects
    const recentMessages = messages.filter(msg => {
      const msgDate = new Date(msg.created_at);
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      return msgDate > oneDayAgo;
    });

    console.log(`📊 Messages de las últimas 24 horas: ${recentMessages.length}`);
    
    if (recentMessages.length > 0) {
      console.log('\n📝 Messages recientes:');
      recentMessages.forEach((msg, index) => {
        console.log(`  ${index + 1}. subject: ${msg.subject || 'N/A'}`);
        console.log(`     from: ${msg.from_email || 'N/A'}`);
        console.log(`     to: ${msg.to_email || 'N/A'}`);
        console.log(`     created_at: ${msg.created_at}`);
        
        // Verificar si tiene synced_object
        const hasSyncedObject = syncedObjects.some(obj => 
          obj.metadata?.subject === msg.subject &&
          obj.metadata?.from === msg.from_email
        );
        
        console.log(`     tiene synced_object: ${hasSyncedObject ? '✅' : '❌'}`);
        console.log('');
      });
    }

    // 5. Resumen
    console.log('📊 RESUMEN:');
    console.log(`   - Synced objects totales: ${syncedObjects.length}`);
    console.log(`   - Messages totales: ${messages.length}`);
    console.log(`   - External IDs duplicados: ${duplicates.length}`);
    console.log(`   - Messages recientes (24h): ${recentMessages.length}`);
    
    if (duplicates.length > 0) {
      console.log('🚨 PROBLEMA: Hay external_ids duplicados en synced_objects');
    } else {
      console.log('✅ No hay external_ids duplicados');
    }

  } catch (error) {
    console.error('❌ Error durante la verificación:', error);
  }
}

// Ejecutar verificación
checkDuplicateEmails().catch(console.error);
