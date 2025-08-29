/**
 * Test script para verificar la extracción de direcciones de email
 */

// Función auxiliar para extraer dirección de email
function extractEmailAddress(emailField) {
  if (!emailField) return '';
  
  console.log(`[EXTRACTION] 🔍 Extrayendo email de: "${emailField}"`);
  
  // Si ya es una dirección de email simple
  if (emailField.includes('@') && !emailField.includes('<')) {
    console.log(`[EXTRACTION] ✅ Email simple encontrado: "${emailField}"`);
    return emailField;
  }
  
  // Extraer de formato "Name <email@domain.com>"
  const match = emailField.match(/<([^>]+)>/);
  if (match) {
    console.log(`[EXTRACTION] ✅ Email extraído de formato <email>: "${match[1]}"`);
    return match[1];
  }
  
  // Buscar patrones de email en el texto
  const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const emails = emailField.match(emailPattern);
  
  if (emails && emails.length > 0) {
    console.log(`[EXTRACTION] ✅ Email encontrado con regex: "${emails[0]}"`);
    return emails[0];
  }
  
  console.log(`[EXTRACTION] ❌ No se pudo extraer email de: "${emailField}"`);
  return emailField;
}

// Simular la lógica de SentEmailDuplicationService.generateEnvelopeBasedId()
function simulateSentEmailDuplicationService(email) {
  try {
    console.log(`[SENT_EMAIL_DEDUP] 🏗️ Generando ID basado en envelope...`);
    
    // Extraer datos requeridos
    const to = email.to || email.recipient;
    const from = email.from || email.sender;
    const subject = email.subject;
    const date = email.date || email.sent_at;
    
    console.log(`[SENT_EMAIL_DEDUP] 📊 Datos originales:`);
    console.log(`   - to: "${to}"`);
    console.log(`   - from: "${from}"`);
    console.log(`   - subject: "${subject}"`);
    console.log(`   - date: "${date}"`);
    
    if (!to || !from || !subject || !date) {
      console.log(`[SENT_EMAIL_DEDUP] ❌ Datos insuficientes para generar ID desde envelope:`, {
        hasTo: !!to,
        hasFrom: !!from, 
        hasSubject: !!subject,
        hasDate: !!date
      });
      return null;
    }
    
    // Normalizar timestamp
    const timestamp = new Date(date);
    if (isNaN(timestamp.getTime())) {
      console.log(`[SENT_EMAIL_DEDUP] ❌ Fecha inválida para envelope ID: ${date}`);
      return null;
    }
    
    // Redondear a DÍA
    const roundedTime = new Date(timestamp);
    roundedTime.setHours(0, 0, 0, 0);
    const timeWindow = roundedTime.toISOString().substring(0, 10);
    
    // 🔧 NORMALIZAR CAMPOS - Extraer solo direcciones de email para consistencia
    const normalizedTo = extractEmailAddress(to).toLowerCase().trim();
    const normalizedFrom = extractEmailAddress(from).toLowerCase().trim();
    const normalizedSubject = subject.toLowerCase().trim().substring(0, 50);
    
    console.log(`[SENT_EMAIL_DEDUP] 📊 Datos normalizados:`);
    console.log(`   - normalizedTo: "${normalizedTo}"`);
    console.log(`   - normalizedFrom: "${normalizedFrom}"`);
    console.log(`   - normalizedSubject: "${normalizedSubject}"`);
    console.log(`   - timeWindow: "${timeWindow}"`);
    
    console.log(`[SENT_EMAIL_DEDUP] 📊 Generando ID: ${normalizedFrom} → ${normalizedTo} (${timeWindow})`);
    
    // Crear string de datos para hash
    const dataString = `${normalizedTo}|${normalizedFrom}|${normalizedSubject}|${timeWindow}`;
    
    // Generar hash estable y determinístico
    let hash = 0;
    for (let i = 0; i < dataString.length; i++) {
      const char = dataString.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
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

// Test principal
async function testEmailExtraction() {
  console.log('🧪 TEST: Verificación de extracción de direcciones de email\n');

  // Casos de prueba
  const testCases = [
    {
      name: 'Email simple',
      from: 'sergio@example.com',
      to: 'hola@uncodie.com',
      subject: 'Test simple',
      date: '2025-08-29T22:10:00Z'
    },
    {
      name: 'Email con formato Name <email>',
      from: 'Sergio Prado <sergio@example.com>',
      to: 'hola@uncodie.com',
      subject: 'Test con formato',
      date: '2025-08-29T22:10:00Z'
    },
    {
      name: 'Email complejo (caso real)',
      from: 'Sergio Prado via Hola Uncodie',
      to: 'hola@uncodie.com',
      subject: 'info',
      date: '2025-08-29T22:10:00Z'
    },
    {
      name: 'Email con texto adicional',
      from: 'Sergio Prado via Hola Uncodie <sergio@example.com>',
      to: 'hola@uncodie.com',
      subject: 'Test con texto',
      date: '2025-08-29T22:10:00Z'
    }
  ];

  console.log('📧 Casos de prueba:');
  testCases.forEach((testCase, index) => {
    console.log(`  ${index + 1}. ${testCase.name}: "${testCase.from}" → "${testCase.to}"`);
  });
  console.log('');

  try {
    for (let i = 0; i < testCases.length; i++) {
      const testCase = testCases[i];
      console.log(`\n🔍 TEST ${i + 1}: ${testCase.name}`);
      console.log('=' .repeat(50));
      
      const email = {
        from: testCase.from,
        to: testCase.to,
        subject: testCase.subject,
        date: testCase.date
      };
      
      const envelopeId = simulateSentEmailDuplicationService(email);
      
      console.log(`\n📊 RESULTADO: ${envelopeId ? '✅ Generado' : '❌ Falló'}`);
      if (envelopeId) {
        console.log(`   Envelope ID: ${envelopeId}`);
      }
      console.log('');
    }

  } catch (error) {
    console.error('❌ Error durante la prueba:', error);
  }
}

// Ejecutar test
testEmailExtraction().catch(console.error);
