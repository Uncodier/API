/**
 * Script para verificar si el email ya existe en la base de datos
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
  
  // Si ya es una dirección de email simple
  if (emailField.includes('@') && !emailField.includes('<')) {
    return emailField;
  }
  
  // Extraer de formato "Name <email@domain.com>"
  const match = emailField.match(/<([^>]+)>/);
  if (match) {
    return match[1];
  }
  
  // Buscar patrones de email en el texto
  const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const emails = emailField.match(emailPattern);
  
  if (emails && emails.length > 0) {
    return emails[0];
  }
  
  return emailField;
}

// Simular diferentes variaciones del email
function generatePossibleEnvelopeIds(email) {
  console.log(`[CHECK] 🔍 Generando posibles envelope IDs para el email...`);
  
  const possibleEmails = [];
  
  // 1. Email original
  possibleEmails.push({
    name: 'Original',
    from: email.from,
    to: email.to,
    subject: email.subject,
    date: email.date
  });
  
  // 2. Variación con email extraído del from
  const extractedEmail = extractEmailAddress(email.from);
  if (extractedEmail !== email.from) {
    possibleEmails.push({
      name: 'Con email extraído',
      from: extractedEmail,
      to: email.to,
      subject: email.subject,
      date: email.date
    });
  }
  
  // 3. Variación con subject simplificado
  possibleEmails.push({
    name: 'Subject simplificado',
    from: email.from,
    to: email.to,
    subject: email.subject.toLowerCase().trim(),
    date: email.date
  });
  
  // 4. Variación con fecha diferente (mismo día)
  const dateObj = new Date(email.date);
  const sameDayVariations = [
    dateObj.toISOString(),
    new Date(dateObj.getTime() - 1000).toISOString(), // -1 segundo
    new Date(dateObj.getTime() + 1000).toISOString(), // +1 segundo
  ];
  
  sameDayVariations.forEach((date, index) => {
    possibleEmails.push({
      name: `Fecha variación ${index + 1}`,
      from: email.from,
      to: email.to,
      subject: email.subject,
      date: date
    });
  });
  
  // Generar envelope IDs
  const envelopeIds = [];
  possibleEmails.forEach(variation => {
    const envelopeId = simulateSentEmailDuplicationService(variation);
    if (envelopeId) {
      envelopeIds.push({
        name: variation.name,
        envelopeId: envelopeId,
        data: variation
      });
    }
  });
  
  return envelopeIds;
}

// Test principal
async function checkEmailExistence() {
  console.log('🧪 TEST: Verificación de existencia de email en base de datos\n');

  // Email de prueba (el caso real del usuario)
  const testEmail = {
    from: 'Sergio Prado via Hola Uncodie',
    to: 'hola@uncodie.com',
    subject: 'info',
    date: '2025-08-29T22:10:00Z'
  };

  console.log('📧 Email de prueba:');
  console.log(`  From: "${testEmail.from}"`);
  console.log(`  To: "${testEmail.to}"`);
  console.log(`  Subject: "${testEmail.subject}"`);
  console.log(`  Date: "${testEmail.date}"`);
  console.log('');

  try {
    // Generar posibles envelope IDs
    const possibleEnvelopeIds = generatePossibleEnvelopeIds(testEmail);
    
    console.log('🔍 Posibles envelope IDs generados:');
    possibleEnvelopeIds.forEach((item, index) => {
      console.log(`  ${index + 1}. ${item.name}: ${item.envelopeId}`);
      console.log(`     From: "${item.data.from}"`);
      console.log(`     To: "${item.data.to}"`);
      console.log(`     Subject: "${item.data.subject}"`);
      console.log(`     Date: "${item.data.date}"`);
      console.log('');
    });

    // Simular verificación en base de datos
    console.log('🔍 Simulando verificación en base de datos...');
    console.log('   (En un entorno real, buscaríamos estos external_ids en synced_objects)');
    
    const envelopeIdList = possibleEnvelopeIds.map(item => item.envelopeId);
    console.log(`   External IDs a buscar: [${envelopeIdList.join(', ')}]`);
    
    // Simular que encontramos uno
    if (possibleEnvelopeIds.length > 0) {
      const foundEnvelopeId = possibleEnvelopeIds[0];
      console.log(`\n✅ Simulación: Encontrado en base de datos:`);
      console.log(`   External ID: ${foundEnvelopeId.envelopeId}`);
      console.log(`   Variación: ${foundEnvelopeId.name}`);
      console.log(`   Esto explicaría por qué el email no se sincroniza`);
    }

    console.log('\n📊 RESUMEN:');
    console.log(`   - Variaciones generadas: ${possibleEnvelopeIds.length}`);
    console.log(`   - External IDs únicos: ${new Set(possibleEnvelopeIds.map(item => item.envelopeId)).size}`);
    console.log(`   - Posible causa: Email ya existe con external_id diferente`);

  } catch (error) {
    console.error('❌ Error durante la verificación:', error);
  }
}

// Ejecutar verificación
checkEmailExistence().catch(console.error);
