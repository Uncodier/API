/**
 * Diagnostic script to understand duplicate response issues
 * This script will help identify why synced_objects is not preventing duplicates
 */

import { supabaseAdmin } from '../src/lib/database/supabase-client.js';
import { SyncedObjectsService } from '../src/lib/services/synced-objects/SyncedObjectsService.js';
import { ComprehensiveEmailFilterService } from '../src/lib/services/email/ComprehensiveEmailFilterService.js';
import { ReceivedEmailDuplicationService } from '../src/lib/services/email/ReceivedEmailDuplicationService.js';

async function diagnoseDuplicateResponses() {
  console.log('🔍 Diagnóstico de respuestas duplicadas...\n');

  try {
    // 1. Verificar datos en synced_objects
    console.log('📊 1. Verificando datos en synced_objects...');
    const { data: syncedObjects, error } = await supabaseAdmin
      .from('synced_objects')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) {
      console.error('❌ Error consultando synced_objects:', error);
      return;
    }

    console.log(`✅ Encontrados ${syncedObjects.length} objetos en synced_objects:`);
    syncedObjects.forEach((obj, index) => {
      console.log(`   ${index + 1}. ID: ${obj.external_id}`);
      console.log(`      - Tipo: ${obj.object_type}`);
      console.log(`      - Status: ${obj.status}`);
      console.log(`      - Site: ${obj.site_id}`);
      console.log(`      - Creado: ${obj.created_at}`);
      console.log(`      - Procesado: ${obj.last_processed_at || 'N/A'}`);
      console.log(`      - Metadata: ${JSON.stringify(obj.metadata, null, 2)}`);
      console.log('');
    });

    // 2. Verificar si hay emails duplicados con diferentes IDs
    console.log('🔍 2. Verificando emails duplicados...');
    const { data: duplicateEmails, error: dupError } = await supabaseAdmin
      .from('synced_objects')
      .select('external_id, object_type, status, metadata, created_at')
      .eq('object_type', 'email')
      .order('created_at', { ascending: false });

    if (dupError) {
      console.error('❌ Error consultando duplicados:', dupError);
      return;
    }

    // Agrupar por subject para encontrar duplicados
    const emailsBySubject = {};
    duplicateEmails.forEach(email => {
      const subject = email.metadata?.subject || 'Sin subject';
      if (!emailsBySubject[subject]) {
        emailsBySubject[subject] = [];
      }
      emailsBySubject[subject].push(email);
    });

    console.log('📧 Emails agrupados por subject:');
    Object.entries(emailsBySubject).forEach(([subject, emails]) => {
      if (emails.length > 1) {
        console.log(`\n⚠️ Subject: "${subject}" (${emails.length} emails):`);
        emails.forEach((email, index) => {
          console.log(`   ${index + 1}. ID: ${email.external_id}`);
          console.log(`      - Status: ${email.status}`);
          console.log(`      - Creado: ${email.created_at}`);
        });
      }
    });

    // 3. Verificar diferencias entre servicios
    console.log('\n🔧 3. Verificando diferencias entre servicios...');
    
    // Simular un email de prueba
    const testEmail = {
      id: 'test-email-123',
      messageId: 'test-email-123',
      from: 'test@example.com',
      to: 'recipient@example.com',
      subject: 'Test Email',
      provider: 'test'
    };

    const testSiteId = 'test-site-id';

    console.log('📝 Probando SyncedObjectsService.filterUnprocessedEmails...');
    const syncedResult = await SyncedObjectsService.filterUnprocessedEmails([testEmail], testSiteId, 'email');
    console.log('   - Resultado:', syncedResult);

    console.log('📝 Probando ReceivedEmailDuplicationService...');
    const receivedResult = await ReceivedEmailDuplicationService.filterUnprocessedReceivedEmails([testEmail], testSiteId);
    console.log('   - Resultado:', receivedResult);

    // 4. Verificar si hay problemas con el upsert
    console.log('\n🔧 4. Verificando lógica de upsert...');
    
    // Crear un objeto de prueba
    const testObject = {
      external_id: 'test-upsert-123',
      site_id: testSiteId,
      object_type: 'email',
      status: 'pending',
      provider: 'test',
      metadata: { subject: 'Test Upsert' }
    };

    console.log('📝 Creando objeto de prueba...');
    const created = await SyncedObjectsService.createObject(testObject);
    console.log('   - Creado:', created?.id);

    console.log('📝 Intentando upsert del mismo objeto...');
    const upsertResult = await SyncedObjectsService.filterUnprocessedEmails([testEmail], testSiteId, 'email');
    console.log('   - Resultado upsert:', upsertResult);

    // 5. Verificar mensajes recientes
    console.log('\n📨 5. Verificando mensajes recientes...');
    const { data: recentMessages, error: msgError } = await supabaseAdmin
      .from('messages')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(10);

    if (msgError) {
      console.error('❌ Error consultando mensajes:', msgError);
    } else {
      console.log(`✅ Encontrados ${recentMessages.length} mensajes recientes:`);
      recentMessages.forEach((msg, index) => {
        console.log(`   ${index + 1}. ID: ${msg.id}`);
        console.log(`      - Content: ${msg.content?.substring(0, 100)}...`);
        console.log(`      - Role: ${msg.role}`);
        console.log(`      - Creado: ${msg.created_at}`);
        console.log(`      - Custom data: ${JSON.stringify(msg.custom_data, null, 2)}`);
        console.log('');
      });
    }

    console.log('\n🎯 Diagnóstico completado. Revisa los logs arriba para identificar el problema.');

  } catch (error) {
    console.error('❌ Error en diagnóstico:', error);
  }
}

// Función para limpiar datos de prueba
async function cleanupTestData() {
  try {
    const { error } = await supabaseAdmin
      .from('synced_objects')
      .delete()
      .eq('external_id', 'test-upsert-123');
    
    if (error) {
      console.warn('⚠️ Cleanup warning:', error);
    } else {
      console.log('🧹 Datos de prueba limpiados');
    }
  } catch (error) {
    console.warn('⚠️ Cleanup error:', error);
  }
}

// Ejecutar diagnóstico
diagnoseDuplicateResponses()
  .then(() => cleanupTestData())
  .catch(console.error);
