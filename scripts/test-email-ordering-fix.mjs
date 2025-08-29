/**
 * Test script para verificar que la corrección del ordenamiento de emails funciona
 */

// Simular emails con diferentes fechas y UIDs
const mockEmails = [
  {
    uid: 1001,
    envelope: {
      date: new Date('2025-08-29T01:00:00Z'),
      subject: 'Email antiguo (UID alto)',
      from: [{ address: 'old@example.com' }],
      to: [{ address: 'test@example.com' }]
    }
  },
  {
    uid: 999,
    envelope: {
      date: new Date('2025-08-29T03:00:00Z'),
      subject: 'Email nuevo (UID bajo)',
      from: [{ address: 'new@example.com' }],
      to: [{ address: 'test@example.com' }]
    }
  },
  {
    uid: 1000,
    envelope: {
      date: new Date('2025-08-29T02:00:00Z'),
      subject: 'Email medio (UID medio)',
      from: [{ address: 'medium@example.com' }],
      to: [{ address: 'test@example.com' }]
    }
  }
];

// Simular la lógica ANTES de la corrección (ordenar por UID)
function simulateOldOrdering(emails, limit) {
  console.log('❌ ANTES de la corrección (ordenar por UID):');
  
  // Sort UIDs in descending order to get newest first
  const sortedUIDs = emails.map(e => e.uid).sort((a, b) => b - a);
  console.log(`  - UIDs ordenados: [${sortedUIDs.join(', ')}]`);
  
  // Take only the newest emails up to the limit
  const limitedUIDs = sortedUIDs.slice(0, limit);
  console.log(`  - UIDs limitados: [${limitedUIDs.join(', ')}]`);
  
  // Get emails by UID order
  const orderedEmails = limitedUIDs.map(uid => 
    emails.find(e => e.uid === uid)
  );
  
  console.log('  - Emails ordenados por UID:');
  orderedEmails.forEach((email, index) => {
    console.log(`    ${index + 1}. UID ${email.uid}: "${email.envelope.subject}" (${email.envelope.date.toISOString()})`);
  });
  
  return orderedEmails;
}

// Simular la lógica DESPUÉS de la corrección (ordenar por fecha)
function simulateNewOrdering(emails, limit) {
  console.log('✅ DESPUÉS de la corrección (ordenar por fecha):');
  
  // Ordenar por fecha (más recientes primero)
  const sortedEmails = emails.sort((a, b) => {
    const dateA = a.envelope?.date?.getTime() || 0;
    const dateB = b.envelope?.date?.getTime() || 0;
    return dateB - dateA; // Descending order (newest first)
  });
  
  console.log(`  - Emails ordenados por fecha: ${sortedEmails.length} emails`);
  
  // Take only the newest emails up to the limit
  const limitedEmails = sortedEmails.slice(0, limit);
  console.log(`  - Emails limitados: ${limitedEmails.length} emails`);
  
  console.log('  - Emails ordenados por fecha:');
  limitedEmails.forEach((email, index) => {
    console.log(`    ${index + 1}. UID ${email.uid}: "${email.envelope.subject}" (${email.envelope.date.toISOString()})`);
  });
  
  return limitedEmails;
}

// Test principal
async function testEmailOrderingFix() {
  console.log('🧪 TEST: Corrección del ordenamiento de emails\n');
  
  console.log('📧 Emails de prueba:');
  mockEmails.forEach((email, index) => {
    console.log(`  ${index + 1}. UID ${email.uid}: "${email.envelope.subject}" (${email.envelope.date.toISOString()})`);
  });
  console.log('');
  
  const limit = 2; // Solo tomar 2 emails para demostrar el problema
  
  // Simular ordenamiento ANTES de la corrección
  const oldOrdering = simulateOldOrdering(mockEmails, limit);
  console.log('');
  
  // Simular ordenamiento DESPUÉS de la corrección
  const newOrdering = simulateNewOrdering(mockEmails, limit);
  console.log('');
  
  // Verificar resultados
  console.log('🔍 VERIFICACIÓN DE RESULTADOS:');
  console.log('=' .repeat(50));
  
  console.log('❌ ANTES (por UID):');
  console.log(`  - Email más reciente: "${oldOrdering[0]?.envelope.subject}"`);
  console.log(`  - Fecha: ${oldOrdering[0]?.envelope.date.toISOString()}`);
  
  console.log('\n✅ DESPUÉS (por fecha):');
  console.log(`  - Email más reciente: "${newOrdering[0]?.envelope.subject}"`);
  console.log(`  - Fecha: ${newOrdering[0]?.envelope.date.toISOString()}`);
  
  // Verificar si la corrección funciona
  const oldIsCorrect = oldOrdering[0]?.envelope.date.getTime() === Math.max(...mockEmails.map(e => e.envelope.date.getTime()));
  const newIsCorrect = newOrdering[0]?.envelope.date.getTime() === Math.max(...mockEmails.map(e => e.envelope.date.getTime()));
  
  console.log('\n📊 RESULTADO:');
  console.log(`  - Ordenamiento por UID correcto: ${oldIsCorrect ? '✅' : '❌'}`);
  console.log(`  - Ordenamiento por fecha correcto: ${newIsCorrect ? '✅' : '❌'}`);
  
  if (!oldIsCorrect && newIsCorrect) {
    console.log('\n🎯 ¡PROBLEMA IDENTIFICADO Y CORREGIDO!');
    console.log('   - El ordenamiento por UID estaba tomando emails antiguos');
    console.log('   - El ordenamiento por fecha ahora toma los emails más recientes');
  } else if (oldIsCorrect && newIsCorrect) {
    console.log('\n✅ Ambos métodos funcionan correctamente');
  } else {
    console.log('\n❌ Hay un problema en la lógica de ordenamiento');
  }
  
  console.log('\n🔧 EXPLICACIÓN:');
  console.log('   - ANTES: Ordenaba por UID (secuencial, no cronológico)');
  console.log('   - DESPUÉS: Ordena por fecha (cronológico real)');
  console.log('   - RESULTADO: Ahora obtiene los emails más recientes correctamente');
}

// Ejecutar test
testEmailOrderingFix().catch(console.error);
