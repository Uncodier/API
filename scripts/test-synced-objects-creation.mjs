/**
 * Test script para verificar si se están creando synced_objects correctamente
 */

// Simular la lógica de SentEmailDuplicationService.generateEnvelopeBasedId()
function simulateSentEmailDuplicationService(email) {
  try {
    // Extraer datos requeridos
    const to = email.to || email.recipient;
    const from = email.from || email.sender;
    const subject = email.subject;
    const date = email.date || email.sent_at;
    
    if (!to || !from || !subject || !date) {
      return null;
    }
    
    // Normalizar timestamp
    const timestamp = new Date(date);
    if (isNaN(timestamp.getTime())) {
      return null;
    }
    
    // Redondear a DÍA
    const roundedTime = new Date(timestamp);
    roundedTime.setHours(0, 0, 0, 0);
    const timeWindow = roundedTime.toISOString().substring(0, 10);
    
    // Normalizar campos
    const normalizedTo = extractEmailAddress(to).toLowerCase().trim();
    const normalizedFrom = extractEmailAddress(from).toLowerCase().trim();
    const normalizedSubject = subject.toLowerCase().trim().substring(0, 50);
    
    // Crear string de datos para hash
    const dataString = `${normalizedTo}|${normalizedFrom}|${normalizedSubject}|${timeWindow}`;
    
    // Generar hash
    let hash = 0;
    for (let i = 0; i < dataString.length; i++) {
      const char = dataString.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    
    // Crear envelope ID
    const envelopeId = `env-${Math.abs(hash).toString(16)}-${timeWindow.replace(/-/g, '')}`;
    
    return envelopeId;
    
  } catch (error) {
    return null;
  }
}

// Función auxiliar para extraer dirección de email
function extractEmailAddress(emailField) {
  if (!emailField) return '';
  
  if (emailField.includes('@') && !emailField.includes('<')) {
    return emailField;
  }
  
  const match = emailField.match(/<([^>]+)>/);
  if (match) {
    return match[1];
  }
  
  return emailField;
}

// Simular la lógica de saveProcessedEmails
function simulateSaveProcessedEmails(emailsToSave, validEmails, emailToEnvelopeMap, siteId) {
  console.log(`[EMAIL_PROCESSING] 💾 Simulando guardado de ${emailsToSave.length} emails procesados...`);
  
  // Generar envelope IDs para los emails válidos
  const emailToEnvelopeMapGenerated = new Map();
  for (const email of validEmails) {
    const envelopeId = simulateSentEmailDuplicationService(email);
    if (envelopeId) {
      emailToEnvelopeMapGenerated.set(email, envelopeId);
    }
  }
  
  // Combinar con el map existente
  const finalEmailToEnvelopeMap = new Map([...emailToEnvelopeMap, ...emailToEnvelopeMapGenerated]);
  
  // Procesar emails para guardar
  const processedEmailsWithEnvelopes = emailsToSave.map(emailObj => {
    const emailId = emailObj.email ? emailObj.email.id : (emailObj.analysis_id || emailObj.id);
    const originalEmail = validEmails.find(ve => ve.id === emailId || ve.messageId === emailId || ve.uid === emailId);
    const envelopeId = originalEmail ? finalEmailToEnvelopeMap.get(originalEmail) : null;
    return { email: emailObj, originalEmail, envelopeId };
  }).filter(item => item.envelopeId);
  
  console.log(`[EMAIL_PROCESSING] 📊 ${processedEmailsWithEnvelopes.length} emails con envelope IDs válidos`);
  
  // Simular la creación de synced_objects
  const syncedObjectsToInsert = processedEmailsWithEnvelopes.map(({ email, originalEmail, envelopeId }) => ({
    external_id: envelopeId,
    site_id: siteId,
    object_type: 'email',
    status: 'processed',
    provider: originalEmail?.provider || 'unknown',
    metadata: {
      subject: originalEmail?.subject,
      from: originalEmail?.from,
      to: originalEmail?.to,
      date: originalEmail?.date || originalEmail?.received_date,
      command_id: (email.isAlias || email.isAILead) ? null : 'test-command-id',
      analysis_timestamp: new Date().toISOString(),
      agent_id: (email.isAlias || email.isAILead) ? null : 'test-agent-id',
      envelope_id: envelopeId,
      source: email.isAlias ? 'alias_direct_response' : 
             email.isAILead ? 'ai_lead_direct_response' : 'email_analysis',
      processing_type: email.isAlias ? 'alias_direct' : 
                      email.isAILead ? 'ai_lead_direct' : 'agent_analysis'
    },
    first_seen_at: new Date().toISOString(),
    last_processed_at: new Date().toISOString(),
    process_count: 1
  }));
  
  console.log(`[EMAIL_PROCESSING] 📝 Synced objects a crear:`);
  syncedObjectsToInsert.forEach((obj, index) => {
    console.log(`  ${index + 1}. external_id: ${obj.external_id}`);
    console.log(`     subject: ${obj.metadata.subject}`);
    console.log(`     from: ${obj.metadata.from}`);
    console.log(`     status: ${obj.status}`);
    console.log(`     source: ${obj.metadata.source}`);
  });
  
  return {
    syncedObjectsToInsert,
    processedEmailsWithEnvelopes,
    finalEmailToEnvelopeMap
  };
}

// Test principal
async function testSyncedObjectsCreation() {
  console.log('🧪 TEST: Verificación de creación de synced_objects\n');

  // Emails de prueba
  const testEmails = [
    {
      id: 'test-1',
      messageId: '<test-1@example.com>',
      from: 'sender1@example.com',
      to: 'recipient@example.com',
      subject: 'Test Email 1',
      date: '2024-01-15T10:30:00Z',
      body: 'Test email body 1'
    },
    {
      id: 'test-2',
      messageId: '<test-2@example.com>',
      from: 'sender2@example.com',
      to: 'recipient@example.com',
      subject: 'Test Email 2',
      date: '2024-01-15T11:30:00Z',
      body: 'Test email body 2'
    }
  ];

  // Emails para guardar (simular resultado de procesamiento)
  const emailsToSave = [
    {
      id: 'test-1',
      analysis_id: 'test-1',
      isAlias: true,
      summary: 'Test email 1 processed'
    },
    {
      id: 'test-2',
      analysis_id: 'test-2',
      isAILead: true,
      summary: 'Test email 2 processed'
    }
  ];

  console.log('📧 Emails de prueba:');
  testEmails.forEach((email, index) => {
    console.log(`  ${index + 1}. ${email.from} → ${email.to} (${email.subject})`);
  });
  console.log('');

  console.log('💾 Emails para guardar:');
  emailsToSave.forEach((email, index) => {
    console.log(`  ${index + 1}. ID: ${email.id}, Tipo: ${email.isAlias ? 'Alias' : email.isAILead ? 'AI Lead' : 'Agent'}`);
  });
  console.log('');

  try {
    // Simular el guardado
    const result = simulateSaveProcessedEmails(emailsToSave, testEmails, new Map(), 'test-site');
    
    console.log('\n🔍 VERIFICACIÓN DE RESULTADOS:');
    console.log(`   - Emails originales: ${testEmails.length}`);
    console.log(`   - Emails para guardar: ${emailsToSave.length}`);
    console.log(`   - Emails con envelope IDs: ${result.processedEmailsWithEnvelopes.length}`);
    console.log(`   - Synced objects a crear: ${result.syncedObjectsToInsert.length}`);
    
    if (result.syncedObjectsToInsert.length > 0) {
      console.log('✅ SE ESTÁN CREANDO SYNCE_OBJECTS CORRECTAMENTE');
    } else {
      console.log('❌ NO SE ESTÁN CREANDO SYNCE_OBJECTS');
    }

    console.log('\n📊 RESUMEN:');
    console.log(`   - Emails procesados: ${result.processedEmailsWithEnvelopes.length}`);
    console.log(`   - Synced objects: ${result.syncedObjectsToInsert.length}`);
    console.log(`   - Envelope IDs generados: ${result.finalEmailToEnvelopeMap.size}`);
    console.log(`   - Creación de synced_objects: ${result.syncedObjectsToInsert.length > 0 ? '✅' : '❌'}`);

  } catch (error) {
    console.error('❌ Error durante la prueba:', error);
  }
}

// Ejecutar test
testSyncedObjectsCreation().catch(console.error);
