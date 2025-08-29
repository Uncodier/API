/**
 * Test script for consistent email ID generation
 * This script verifies that EmailIdGenerator produces the same ID for the same email across different services
 */

import { EmailIdGenerator } from '../src/lib/services/email/EmailIdGenerator.js';

async function testConsistentIds() {
  console.log('🧪 Testing consistent email ID generation...\n');

  try {
    // Test 1: Email con messageId válido
    console.log('📝 Test 1: Email con messageId válido...');
    const email1 = {
      subject: 'Test Email',
      to: 'test@example.com',
      from: 'sender@example.com',
      date: new Date().toISOString(),
      messageId: 'test-message-id-123@example.com'
    };

    const id1a = EmailIdGenerator.generateConsistentEmailId(email1);
    const id1b = EmailIdGenerator.generateConsistentEmailId(email1);
    const id1c = EmailIdGenerator.generateReceivedEmailId(email1);
    const id1d = EmailIdGenerator.generateSentEmailId(email1);

    console.log('   - ID consistente (a):', id1a);
    console.log('   - ID consistente (b):', id1b);
    console.log('   - ID recibido:', id1c);
    console.log('   - ID enviado:', id1d);
    console.log('   - ¿Consistente?:', id1a === id1b && id1a === id1c && id1a === id1d);

    // Test 2: Email sin messageId (debe generar envelope ID)
    console.log('\n📝 Test 2: Email sin messageId (envelope ID)...');
    const email2 = {
      subject: 'Test Email Without MessageId',
      to: 'recipient@example.com',
      from: 'sender@example.com',
      date: new Date().toISOString()
      // Sin messageId
    };

    const id2a = EmailIdGenerator.generateConsistentEmailId(email2);
    const id2b = EmailIdGenerator.generateConsistentEmailId(email2);
    const id2c = EmailIdGenerator.generateReceivedEmailId(email2);
    const id2d = EmailIdGenerator.generateSentEmailId(email2);

    console.log('   - ID consistente (a):', id2a);
    console.log('   - ID consistente (b):', id2b);
    console.log('   - ID recibido:', id2c);
    console.log('   - ID enviado:', id2d);
    console.log('   - ¿Consistente?:', id2a === id2b);
    console.log('   - ¿Diferentes prefijos?:', id2c?.startsWith('recv-'), id2d?.startsWith('sent-'));

    // Test 3: Email con formato complejo
    console.log('\n📝 Test 3: Email con formato complejo...');
    const email3 = {
      subject: 'Complex Email Format',
      to: 'John Doe <john.doe@example.com>',
      from: 'Jane Smith <jane.smith@company.com>',
      date: new Date().toISOString(),
      messageId: 'complex-message-id-456@company.com'
    };

    const id3a = EmailIdGenerator.generateConsistentEmailId(email3);
    const id3b = EmailIdGenerator.generateConsistentEmailId(email3);

    console.log('   - ID consistente (a):', id3a);
    console.log('   - ID consistente (b):', id3b);
    console.log('   - ¿Consistente?:', id3a === id3b);

    // Test 4: Comparación de emails
    console.log('\n📝 Test 4: Comparación de emails...');
    const email4a = {
      subject: 'Same Email',
      to: 'test@example.com',
      from: 'sender@example.com',
      date: new Date().toISOString(),
      messageId: 'same-message-id@example.com'
    };

    const email4b = {
      subject: 'Same Email',
      to: 'test@example.com',
      from: 'sender@example.com',
      date: new Date().toISOString(),
      messageId: 'same-message-id@example.com'
    };

    const email4c = {
      subject: 'Different Email',
      to: 'different@example.com',
      from: 'sender@example.com',
      date: new Date().toISOString(),
      messageId: 'different-message-id@example.com'
    };

    const areSame1 = EmailIdGenerator.areSameEmail(email4a, email4b);
    const areSame2 = EmailIdGenerator.areSameEmail(email4a, email4c);

    console.log('   - ¿Email 4a y 4b son iguales?:', areSame1);
    console.log('   - ¿Email 4a y 4c son iguales?:', areSame2);

    // Test 5: Email con ID inválido
    console.log('\n📝 Test 5: Email con ID inválido...');
    const email5 = {
      subject: 'Invalid ID Email',
      to: 'test@example.com',
      from: 'sender@example.com',
      date: new Date().toISOString(),
      messageId: '123' // ID muy corto
    };

    const id5a = EmailIdGenerator.generateConsistentEmailId(email5);
    const id5b = EmailIdGenerator.generateConsistentEmailId(email5);

    console.log('   - ID consistente (a):', id5a);
    console.log('   - ID consistente (b):', id5b);
    console.log('   - ¿Consistente?:', id5a === id5b);
    console.log('   - ¿Usa envelope ID?:', id5a?.startsWith('env-'));

    console.log('\n🎯 Todos los tests completados. Revisa los resultados arriba.');

  } catch (error) {
    console.error('❌ Test failed:', error);
  }
}

// Ejecutar test
testConsistentIds().catch(console.error);
