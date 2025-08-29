/**
 * Test script para verificar que todos los servicios generan IDs consistentes
 * usando la misma lógica que sendEmail
 */

import { SentEmailDuplicationService } from '../src/lib/services/email/SentEmailDuplicationService.ts';
import { SyncedObjectsService } from '../src/lib/services/synced-objects/SyncedObjectsService.ts';
import { ComprehensiveEmailFilterService } from '../src/lib/services/email/ComprehensiveEmailFilterService.ts';

async function testUnifiedIdGeneration() {
  console.log('🧪 TEST: Verificación de generación unificada de IDs\n');

  // Email de prueba
  const testEmail = {
    id: 'test-123',
    messageId: '<test-message-id@example.com>',
    uid: '456',
    from: 'sender@example.com',
    to: 'recipient@example.com',
    subject: 'Test Email Subject',
    date: '2024-01-15T10:30:00Z',
    body: 'Test email body content'
  };

  console.log('📧 Email de prueba:');
  console.log(`  From: ${testEmail.from}`);
  console.log(`  To: ${testEmail.to}`);
  console.log(`  Subject: ${testEmail.subject}`);
  console.log(`  Date: ${testEmail.date}`);
  console.log(`  MessageId: ${testEmail.messageId}`);
  console.log('');

  try {
    // 1. Test SentEmailDuplicationService (la referencia)
    console.log('1️⃣ SentEmailDuplicationService.generateEnvelopeBasedId():');
    const sentEmailId = SentEmailDuplicationService.generateEnvelopeBasedId(testEmail);
    console.log(`   Resultado: ${sentEmailId}`);
    console.log('');

    // 2. Test SyncedObjectsService (debe usar la misma lógica)
    console.log('2️⃣ SyncedObjectsService.generateConsistentEnvelopeId():');
    const syncedObjectsId = SyncedObjectsService.generateConsistentEnvelopeId(testEmail);
    console.log(`   Resultado: ${syncedObjectsId}`);
    console.log('');

    // 3. Test ComprehensiveEmailFilterService (debe usar la misma lógica)
    console.log('3️⃣ ComprehensiveEmailFilterService (generateEnvelopeIds):');
    const emailToEnvelopeMap = ComprehensiveEmailFilterService.generateEnvelopeIds([testEmail]);
    const comprehensiveId = emailToEnvelopeMap.get(testEmail);
    console.log(`   Resultado: ${comprehensiveId}`);
    console.log('');

    // Verificar consistencia
    console.log('🔍 VERIFICACIÓN DE CONSISTENCIA:');
    const ids = [sentEmailId, syncedObjectsId, comprehensiveId];
    const uniqueIds = new Set(ids.filter(Boolean));
    
    if (uniqueIds.size === 1) {
      console.log('✅ TODOS LOS SERVICIOS GENERAN EL MISMO ID!');
      console.log(`   ID unificado: ${Array.from(uniqueIds)[0]}`);
    } else {
      console.log('❌ LOS SERVICIOS GENERAN IDs DIFERENTES:');
      ids.forEach((id, index) => {
        const serviceNames = [
          'SentEmailDuplicationService',
          'SyncedObjectsService', 
          'ComprehensiveEmailFilterService'
        ];
        console.log(`   ${serviceNames[index]}: ${id || 'null'}`);
      });
    }

    console.log('\n📊 RESUMEN:');
    console.log(`   - SentEmailDuplicationService: ${sentEmailId ? '✅' : '❌'}`);
    console.log(`   - SyncedObjectsService: ${syncedObjectsId ? '✅' : '❌'}`);
    console.log(`   - ComprehensiveEmailFilterService: ${comprehensiveId ? '✅' : '❌'}`);
    console.log(`   - Consistencia: ${uniqueIds.size === 1 ? '✅' : '❌'}`);

  } catch (error) {
    console.error('❌ Error durante la prueba:', error);
  }
}

// Ejecutar test
testUnifiedIdGeneration().catch(console.error);
