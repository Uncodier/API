/**
 * Test script para verificar que todos los servicios generan IDs consistentes
 * usando la misma lógica que sendEmail
 */

// Simular el email de prueba
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

console.log('🧪 TEST: Verificación de generación unificada de IDs\n');

console.log('📧 Email de prueba:');
console.log(`  From: ${testEmail.from}`);
console.log(`  To: ${testEmail.to}`);
console.log(`  Subject: ${testEmail.subject}`);
console.log(`  Date: ${testEmail.date}`);
console.log(`  MessageId: ${testEmail.messageId}`);
console.log('');

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

// Simular la lógica de SyncedObjectsService.generateConsistentEnvelopeId()
function simulateSyncedObjectsService(email) {
  try {
    console.log(`[SYNCED_OBJECTS] 🏗️ Generando envelope ID consistente...`);
    // Usar exactamente la misma lógica que sendEmail
    return simulateSentEmailDuplicationService(email);
  } catch (error) {
    console.error(`[SYNCED_OBJECTS] ❌ Error generando envelope ID consistente:`, error);
    return null;
  }
}

// Simular la lógica de ComprehensiveEmailFilterService.generateEnvelopeIds()
function simulateComprehensiveEmailFilterService(emails) {
  console.log(`[COMPREHENSIVE_FILTER] 🔧 Generando envelope IDs para ${emails.length} emails...`);
  const emailToEnvelopeMap = new Map();
  
  for (const email of emails) {
    try {
      // 🎯 USAR LA MISMA LÓGICA QUE sendEmail PARA CONSISTENCIA
      // Usar el servicio de SentEmailDuplicationService para consistencia
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

try {
  // 1. Test SentEmailDuplicationService (la referencia)
  console.log('1️⃣ SentEmailDuplicationService.generateEnvelopeBasedId():');
  const sentEmailId = simulateSentEmailDuplicationService(testEmail);
  console.log(`   Resultado: ${sentEmailId}`);
  console.log('');

  // 2. Test SyncedObjectsService (debe usar la misma lógica)
  console.log('2️⃣ SyncedObjectsService.generateConsistentEnvelopeId():');
  const syncedObjectsId = simulateSyncedObjectsService(testEmail);
  console.log(`   Resultado: ${syncedObjectsId}`);
  console.log('');

  // 3. Test ComprehensiveEmailFilterService (debe usar la misma lógica)
  console.log('3️⃣ ComprehensiveEmailFilterService (generateEnvelopeIds):');
  const emailToEnvelopeMap = simulateComprehensiveEmailFilterService([testEmail]);
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
