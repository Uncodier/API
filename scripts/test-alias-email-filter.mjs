/**
 * Test script para verificar que los emails a aliases se procesan correctamente
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

// Simular la lógica de getProcessedEmails (sin emails procesados)
function simulateGetProcessedEmails(envelopeIds, siteId) {
  console.log(`[COMPREHENSIVE_FILTER] 🔍 Verificando emails procesados para ${envelopeIds.length} envelope IDs...`);
  
  // Simular que NO hay emails procesados (email nuevo)
  const processedEnvelopeIds = new Set();
  
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

// Simular la lógica de filtros básicos
function simulateBasicFilters(emails, normalizedAliases) {
  console.log(`[COMPREHENSIVE_FILTER] 🔧 Aplicando filtros básicos a ${emails.length} emails...`);
  
  const filteredEmails = emails.filter(email => {
    const emailTo = (email.to || '').toLowerCase().trim();
    
    // Verificar si es un email a alias
    const isToAlias = normalizedAliases.includes(emailTo);
    
    if (isToAlias) {
      console.log(`[COMPREHENSIVE_FILTER] 📧 Email a ALIAS detectado: ${email.from} → ${emailTo}`);
      return true;
    }
    
    console.log(`[COMPREHENSIVE_FILTER] ❌ Email NO es a alias: ${email.from} → ${emailTo}`);
    return false;
  });
  
  console.log(`[COMPREHENSIVE_FILTER] ✅ Filtros básicos completados: ${filteredEmails.length}/${emails.length} emails pasaron`);
  return filteredEmails;
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
async function testAliasEmailFilter() {
  console.log('🧪 TEST: Verificación de filtro para emails a aliases\n');

  // Email de prueba (el caso real del usuario)
  const testEmails = [
    {
      id: 'test-1',
      messageId: '<test-1@example.com>',
      from: 'Sergio Prado via Hola Uncodie',
      to: 'hola@uncodie.com', // Alias
      subject: 'info',
      date: '2025-08-29T22:10:00Z',
      body: 'hola, me llego un correo con info de sus agentes, y quisiera más detalles.'
    }
  ];

  // Simular AI leads map (vacío para este caso)
  const aiLeadsMap = new Map();

  // Simular aliases configurados
  const normalizedAliases = ['hola@uncodie.com', 'ventas@uncodie.com'];

  console.log('📧 Email de prueba:');
  testEmails.forEach((email, index) => {
    const isToAlias = normalizedAliases.includes(email.to);
    console.log(`  ${index + 1}. ${email.from} → ${email.to} (${email.subject}) ${isToAlias ? '📧 [ALIAS]' : ''}`);
  });
  console.log('');

  console.log('📋 Configuración:');
  console.log(`  - Aliases configurados: [${normalizedAliases.join(', ')}]`);
  console.log(`  - AI leads encontrados: ${aiLeadsMap.size}`);
  console.log('');

  try {
    // 1. Generar envelope IDs
    console.log('1️⃣ Generando envelope IDs...');
    const emailToEnvelopeMap = simulateGenerateEnvelopeIds(testEmails);
    console.log('');

    // 2. Aplicar filtros básicos
    console.log('2️⃣ Aplicando filtros básicos...');
    const basicFilteredEmails = simulateBasicFilters(testEmails, normalizedAliases);
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
    
    if (validEmails.length > 0) {
      console.log('✅ EMAIL A ALIAS PROCESADO CORRECTAMENTE');
      validEmails.forEach(email => {
        console.log(`   - ${email.from} → ${email.to} (${email.subject}) será procesado`);
      });
    } else {
      console.log('❌ EMAIL A ALIAS NO FUE PROCESADO');
    }

    console.log('\n📊 RESUMEN:');
    console.log(`   - Envelope IDs generados: ${emailToEnvelopeMap.size}`);
    console.log(`   - Emails procesados simulados: ${processedEnvelopeIds.size}`);
    console.log(`   - Emails válidos finales: ${validEmails.length}`);
    console.log(`   - Procesamiento de emails a alias: ${validEmails.length > 0 ? '✅' : '❌'}`);

  } catch (error) {
    console.error('❌ Error durante la prueba:', error);
  }
}

// Ejecutar test
testAliasEmailFilter().catch(console.error);
