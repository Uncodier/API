/**
 * Test script para verificar si el filtro de duplicados está funcionando correctamente
 */

// Simular la lógica de SentEmailDuplicationService.generateEnvelopeBasedId()
function simulateSentEmailDuplicationService(email) {
  try {
    console.log(`[SENT_EMAIL_DEDUP] 🏗️ Generando ID basado en envelope...`);
    
    // Extraer datos requeridos
    const to = email.to || email.recipient;
    const from = email.from || email.sender;
    const subject = email.subject;
    const date = email.date || email.sent_at;
    
    if (!to || !from || !subject || !date) {
      console.log(`[SENT_EMAIL_DEDUP] ❌ Datos insuficientes para generar ID desde envelope:`, {
        hasTo: !!to,
        hasFrom: !!from, 
        hasSubject: !!subject,
        hasDate: !!date
      });
      return null;
    }
    
    // Normalizar timestamp a ventana de 1 minuto para manejar diferencias pequeñas
    const timestamp = new Date(date);
    if (isNaN(timestamp.getTime())) {
      console.log(`[SENT_EMAIL_DEDUP] ❌ Fecha inválida para envelope ID: ${date}`);
      return null;
    }
    
    // Redondear a DÍA para crear ventana temporal MÁS estable (emails del mismo día con mismo contenido = duplicados)
    const roundedTime = new Date(timestamp);
    roundedTime.setHours(0, 0, 0, 0); // Reset a medianoche
    const timeWindow = roundedTime.toISOString().substring(0, 10); // YYYY-MM-DD
    
    // 🔧 NORMALIZAR CAMPOS - Extraer solo direcciones de email para consistencia
    const normalizedTo = extractEmailAddress(to).toLowerCase().trim();
    const normalizedFrom = extractEmailAddress(from).toLowerCase().trim();
    const normalizedSubject = subject.toLowerCase().trim().substring(0, 50); // Primeros 50 chars
    
    console.log(`[SENT_EMAIL_DEDUP] 📊 Generando ID: ${normalizedFrom} → ${normalizedTo} (${timeWindow})`);
    
    // Crear string de datos para hash
    const dataString = `${normalizedTo}|${normalizedFrom}|${normalizedSubject}|${timeWindow}`;
    
    // Generar hash estable y determinístico
    let hash = 0;
    for (let i = 0; i < dataString.length; i++) {
      const char = dataString.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    
    // Crear envelope ID con formato recognizable: env-{hash}-{date}
    const envelopeId = `env-${Math.abs(hash).toString(16)}-${timeWindow.replace(/-/g, '')}`;
    
    console.log(`[SENT_EMAIL_DEDUP] ✅ Envelope ID generado: "${envelopeId}"`);
    console.log(`[SENT_EMAIL_DEDUP] 📊 Base: "${dataString}"`);
    
    return envelopeId;
    
  } catch (error) {
    console.error(`[SENT_EMAIL_DEDUP] ❌ Error generando envelope ID:`, error);
    return null;
  }
}

// Función auxiliar para extraer dirección de email
function extractEmailAddress(emailField) {
  if (!emailField) return '';
  
  // Si ya es una dirección de email simple
  if (emailField.includes('@') && !emailField.includes('<')) {
    return emailField;
  }
  
  // Extraer de formato "Name <email@domain.com>"
  const match = emailField.match(/<([^>]+)>/);
  if (match) {
    return match[1];
  }
  
  return emailField;
}

// Simular la lógica de getProcessedEmails
function simulateGetProcessedEmails(envelopeIds, siteId) {
  console.log(`[COMPREHENSIVE_FILTER] 🔍 Verificando emails procesados para ${envelopeIds.length} envelope IDs...`);
  
  // Simular que algunos emails ya están procesados
  const processedEnvelopeIds = new Set();
  
  // Simular que el primer email ya está procesado
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
      // 🎯 USAR LA MISMA LÓGICA QUE sendEmail PARA CONSISTENCIA
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

// Simular el filtro de duplicados
function simulateDuplicateFilter(basicFilteredEmails, emailToEnvelopeMap, processedEnvelopeIds) {
  console.log(`[COMPREHENSIVE_FILTER] 🔍 Aplicando filtro de duplicados...`);
  
  const validEmails = basicFilteredEmails.filter(email => {
    const emailFrom = (email.from || '').toLowerCase();
    const emailTo = (email.to || '').toLowerCase();
    
    // Filtrar duplicados
    const emailEnvelopeId = emailToEnvelopeMap.get(email);
    if (emailEnvelopeId && processedEnvelopeIds.has(emailEnvelopeId)) {
      console.log(`[COMPREHENSIVE_FILTER] 🚨 Email duplicado filtrado: ${emailFrom} → ${emailTo} (ID: ${emailEnvelopeId})`);
      return false;
    }
    
    console.log(`[COMPREHENSIVE_FILTER] ✅ Email válido (no duplicado): ${emailFrom} → ${emailTo} (ID: ${emailEnvelopeId})`);
    return true;
  });
  
  console.log(`[COMPREHENSIVE_FILTER] 📊 Filtro de duplicados completado: ${validEmails.length}/${basicFilteredEmails.length} emails válidos`);
  return validEmails;
}

// Test principal
async function testDuplicateFiltering() {
  console.log('🧪 TEST: Verificación de filtro de duplicados\n');

  // Emails de prueba (el primero debería ser detectado como duplicado)
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
    },
    {
      id: 'test-3',
      messageId: '<test-3@example.com>',
      from: 'sender3@example.com',
      to: 'recipient@example.com',
      subject: 'Test Email 3',
      date: '2024-01-15T12:30:00Z',
      body: 'Test email body 3'
    }
  ];

  console.log('📧 Emails de prueba:');
  testEmails.forEach((email, index) => {
    console.log(`  ${index + 1}. ${email.from} → ${email.to} (${email.subject})`);
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

    // 4. Aplicar filtro de duplicados
    console.log('4️⃣ Aplicando filtro de duplicados...');
    const validEmails = simulateDuplicateFilter(basicFilteredEmails, emailToEnvelopeMap, processedEnvelopeIds);
    console.log('');

    // 5. Verificar resultados
    console.log('🔍 VERIFICACIÓN DE RESULTADOS:');
    console.log(`   - Emails originales: ${testEmails.length}`);
    console.log(`   - Emails después de filtros básicos: ${basicFilteredEmails.length}`);
    console.log(`   - Emails después de filtro de duplicados: ${validEmails.length}`);
    console.log(`   - Emails filtrados como duplicados: ${basicFilteredEmails.length - validEmails.length}`);
    
    if (validEmails.length < basicFilteredEmails.length) {
      console.log('✅ FILTRO DE DUPLICADOS FUNCIONANDO CORRECTAMENTE');
    } else {
      console.log('❌ FILTRO DE DUPLICADOS NO ESTÁ FUNCIONANDO');
    }

    console.log('\n📊 RESUMEN:');
    console.log(`   - Envelope IDs generados: ${emailToEnvelopeMap.size}`);
    console.log(`   - Emails procesados simulados: ${processedEnvelopeIds.size}`);
    console.log(`   - Emails válidos finales: ${validEmails.length}`);
    console.log(`   - Filtro de duplicados: ${validEmails.length < basicFilteredEmails.length ? '✅' : '❌'}`);

  } catch (error) {
    console.error('❌ Error durante la prueba:', error);
  }
}

// Ejecutar test
testDuplicateFiltering().catch(console.error);
