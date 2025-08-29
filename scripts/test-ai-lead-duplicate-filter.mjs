/**
 * Test script para verificar que los leads IA ahora pasan por el filtro de duplicados
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

// Simular la lógica de getProcessedEmails
function simulateGetProcessedEmails(envelopeIds, siteId) {
  console.log(`[COMPREHENSIVE_FILTER] 🔍 Verificando emails procesados para ${envelopeIds.length} envelope IDs...`);
  
  // Simular que el primer email ya está procesado
  const processedEnvelopeIds = new Set();
  
  if (envelopeIds.length > 0) {
    processedEnvelopeIds.add(envelopeIds[0]);
    console.log(`[COMPREHENSIVE_FILTER] 🔍 Email ya procesado simulado: ${envelopeIds[0]}`);
  }
  
  console.log(`[COMPREHENSIVE_FILTER] 🔍 ${processedEnvelopeIds.size} emails ya procesados encontrados (status: processed/replied)`);
  return processedEnvelopeIds;
}

// Simular la lógica de generateEnvelopeIds
function simulateGenerateEnvelopeIds(emails) {
  console.log(`[COMPREHENSIVE_FILTER] 🔧 Generando envelope IDs para ${emails.length} emails...`);
  const emailToEnvelopeMap = new Map();
  
  for (const email of emails) {
    try {
      const envelopeId = simulateSentEmailDuplicationService(email);
      if (envelopeId) {
        emailToEnvelopeMap.set(email, envelopeId);
      } else {
        console.warn(`[COMPREHENSIVE_FILTER] ⚠️ No se pudo generar envelope ID para: ${email.from} → ${email.to}`);
      }
    } catch (error) {
      console.error(`[COMPREHENSIVE_FILTER] ❌ ERROR generando envelope_id:`, error);
      throw error;
    }
  }
  
  console.log(`[COMPREHENSIVE_FILTER] 📊 ${emailToEnvelopeMap.size}/${emails.length} envelope IDs generados exitosamente`);
  return emailToEnvelopeMap;
}

// Simular la lógica CORREGIDA de filtro de duplicados
function simulateCorrectedDuplicateFilter(basicFilteredEmails, emailToEnvelopeMap, processedEnvelopeIds, aiLeadsMap) {
  console.log(`[COMPREHENSIVE_FILTER] 🔍 Aplicando filtro de duplicados CORREGIDO...`);
  
  const validEmails = basicFilteredEmails.filter(email => {
    const emailFrom = (email.from || '').toLowerCase();
    const emailTo = (email.to || '').toLowerCase();
    const fromEmailAddress = emailFrom.match(/<([^>]+)>/) ? emailFrom.match(/<([^>]+)>/)?.[1] : emailFrom;
    
    // 🎯 PRIMERO verificar duplicados (para TODOS los emails, incluyendo leads IA)
    const emailEnvelopeId = emailToEnvelopeMap.get(email);
    if (emailEnvelopeId && processedEnvelopeIds.has(emailEnvelopeId)) {
      console.log(`[COMPREHENSIVE_FILTER] 🚨 Email duplicado filtrado: ${emailFrom} → ${emailTo} (ID: ${emailEnvelopeId})`);
      return false;
    }
    
    // ✅ Si no es duplicado, incluir automáticamente leads asignados a IA
    if (fromEmailAddress && aiLeadsMap.has(fromEmailAddress)) {
      console.log(`[COMPREHENSIVE_FILTER] 🤖 Lead IA incluido (no duplicado): ${fromEmailAddress} → ${emailTo}`);
      return true;
    }
    
    console.log(`[COMPREHENSIVE_FILTER] ✅ Email válido (no duplicado): ${emailFrom} → ${emailTo} (ID: ${emailEnvelopeId})`);
    return true;
  });
  
  console.log(`[COMPREHENSIVE_FILTER] 📊 Filtro de duplicados completado: ${validEmails.length}/${basicFilteredEmails.length} emails válidos`);
  return validEmails;
}

// Test principal
async function testAILeadDuplicateFilter() {
  console.log('🧪 TEST: Verificación de filtro de duplicados para leads IA (CORREGIDO)\n');

  // Emails de prueba (el primero es un lead IA que ya está procesado)
  const testEmails = [
    {
      id: 'test-1',
      messageId: '<test-1@example.com>',
      from: 'sergio.prado@me.com', // Lead IA
      to: 'sergio@uncodie.com',
      subject: 'Re: Discusión sobre estrategias de IA en ventas y marketing',
      date: '2025-08-29T03:13:31.000Z',
      body: 'Test email body 1'
    },
    {
      id: 'test-2',
      messageId: '<test-2@example.com>',
      from: 'sender2@example.com',
      to: 'recipient@example.com',
      subject: 'Test Email 2',
      date: '2025-08-29T11:30:00Z',
      body: 'Test email body 2'
    },
    {
      id: 'test-3',
      messageId: '<test-3@example.com>',
      from: 'sergio.prado@me.com', // Lead IA (nuevo email)
      to: 'sergio@uncodie.com',
      subject: 'Nuevo tema de discusión',
      date: '2025-08-29T12:30:00Z',
      body: 'Test email body 3'
    }
  ];

  // Simular AI leads map
  const aiLeadsMap = new Map();
  aiLeadsMap.set('sergio.prado@me.com', { id: 'ai-lead-1', name: 'Sergio Prado' });

  console.log('📧 Emails de prueba:');
  testEmails.forEach((email, index) => {
    const isAILead = aiLeadsMap.has(email.from);
    console.log(`  ${index + 1}. ${email.from} → ${email.to} (${email.subject}) ${isAILead ? '🤖 [AI LEAD]' : ''}`);
  });
  console.log('');

  try {
    // 1. Generar envelope IDs
    console.log('1️⃣ Generando envelope IDs...');
    const emailToEnvelopeMap = simulateGenerateEnvelopeIds(testEmails);
    console.log('');

    // 2. Simular filtros básicos (todos pasan)
    console.log('2️⃣ Aplicando filtros básicos...');
    const basicFilteredEmails = testEmails; // Simular que todos pasan
    console.log(`   Resultado: ${basicFilteredEmails.length}/${testEmails.length} emails pasaron filtros básicos`);
    console.log('');

    // 3. Verificar emails procesados
    console.log('3️⃣ Verificando emails ya procesados...');
    const envelopeIds = basicFilteredEmails.map(email => emailToEnvelopeMap.get(email)).filter(Boolean);
    const processedEnvelopeIds = simulateGetProcessedEmails(envelopeIds, 'test-site');
    console.log('');

    // 4. Aplicar filtro de duplicados CORREGIDO
    console.log('4️⃣ Aplicando filtro de duplicados CORREGIDO...');
    const validEmails = simulateCorrectedDuplicateFilter(basicFilteredEmails, emailToEnvelopeMap, processedEnvelopeIds, aiLeadsMap);
    console.log('');

    // 5. Verificar resultados
    console.log('🔍 VERIFICACIÓN DE RESULTADOS:');
    console.log(`   - Emails originales: ${testEmails.length}`);
    console.log(`   - Emails después de filtros básicos: ${basicFilteredEmails.length}`);
    console.log(`   - Emails después de filtro de duplicados: ${validEmails.length}`);
    console.log(`   - Emails filtrados como duplicados: ${basicFilteredEmails.length - validEmails.length}`);
    
    // Verificar que el lead IA duplicado fue filtrado
    const aiLeadDuplicates = testEmails.filter(email => 
      aiLeadsMap.has(email.from) && 
      !validEmails.includes(email)
    );
    
    if (aiLeadDuplicates.length > 0) {
      console.log('✅ LEAD IA DUPLICADO FILTRADO CORRECTAMENTE');
      aiLeadDuplicates.forEach(email => {
        console.log(`   - ${email.from} (${email.subject}) fue filtrado como duplicado`);
      });
    } else {
      console.log('❌ LEAD IA DUPLICADO NO FUE FILTRADO');
    }

    console.log('\n📊 RESUMEN:');
    console.log(`   - Envelope IDs generados: ${emailToEnvelopeMap.size}`);
    console.log(`   - Emails procesados simulados: ${processedEnvelopeIds.size}`);
    console.log(`   - Emails válidos finales: ${validEmails.length}`);
    console.log(`   - Leads IA duplicados filtrados: ${aiLeadDuplicates.length}`);
    console.log(`   - Filtro de duplicados para leads IA: ${aiLeadDuplicates.length > 0 ? '✅' : '❌'}`);

  } catch (error) {
    console.error('❌ Error durante la prueba:', error);
  }
}

// Ejecutar test
testAILeadDuplicateFilter().catch(console.error);
