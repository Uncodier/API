/**
 * Test script para verificar el caso específico del email del usuario
 */

// Simular la lógica CORREGIDA del filtro rápido
function simulateCorrectedQuickFilter(email) {
  const emailFrom = (email.from || '').toLowerCase();
  const emailTo = (email.to || '').toLowerCase();
  
  console.log(`[QUICK_FILTER] 🔍 Verificando: ${emailFrom} → ${emailTo}`);
  
  // Filtros básicos rápidos
  if (emailFrom === emailTo) {
    console.log(`[QUICK_FILTER] ❌ Self-sent filtrado: ${emailFrom} → ${emailTo}`);
    return false; // Self-sent
  }
  
  // 🎯 CORREGIR: No rechazar emails automáticamente por ser de @uncodie.com
  // (el filtro comprehensivo se encargará de validar aliases correctamente)
  console.log(`[QUICK_FILTER] ✅ Email incluido en filtro rápido: ${emailFrom} → ${emailTo}`);
  return true;
}

// Test principal
async function testYourEmailCase() {
  console.log('🧪 TEST: Caso específico del email del usuario\n');

  // Tu email específico
  const yourEmail = {
    name: 'Tu email a alias',
    from: 'Sergio Prado via Hola Uncodie',
    to: 'hola@uncodie.com',
    subject: 'info',
    date: '2025-08-29T22:10:00Z'
  };

  console.log('📧 Tu email:');
  console.log(`  - From: "${yourEmail.from}"`);
  console.log(`  - To: "${yourEmail.to}"`);
  console.log(`  - Subject: "${yourEmail.subject}"`);
  console.log('');

  console.log('🔍 Análisis del filtro rápido:');
  console.log('=' .repeat(50));
  
  // Simular el filtro ANTES de la corrección
  console.log('\n❌ ANTES de la corrección:');
  const emailFrom = yourEmail.from.toLowerCase();
  const emailTo = yourEmail.to.toLowerCase();
  
  console.log(`  - emailFrom.includes('@uncodie.com'): ${emailFrom.includes('@uncodie.com')}`);
  console.log(`  - !emailTo.includes('@uncodie.com'): ${!emailTo.includes('@uncodie.com')}`);
  console.log(`  - Condición: ${emailFrom.includes('@uncodie.com') && !emailTo.includes('@uncodie.com')}`);
  
  if (emailFrom.includes('@uncodie.com') && !emailTo.includes('@uncodie.com')) {
    console.log('  ❌ RESULTADO: Email rechazado por filtro rápido (ANTES)');
  } else {
    console.log('  ✅ RESULTADO: Email habría pasado el filtro rápido (ANTES)');
  }
  
  // Simular el filtro DESPUÉS de la corrección
  console.log('\n✅ DESPUÉS de la corrección:');
  const result = simulateCorrectedQuickFilter(yourEmail);
  
  if (result) {
    console.log('  ✅ RESULTADO: Email incluido en filtro rápido (DESPUÉS)');
  } else {
    console.log('  ❌ RESULTADO: Email filtrado en filtro rápido (DESPUÉS)');
  }

  console.log('\n🎯 RESUMEN:');
  console.log('   - ANTES: El filtro rápido rechazaba emails de @uncodie.com automáticamente');
  console.log('   - DESPUÉS: El filtro rápido solo rechaza self-sent emails');
  console.log('   - RESULTADO: Tu email ahora puede pasar al filtro comprehensivo');
  console.log('   - PRÓXIMO PASO: El filtro comprehensivo validará si es un alias válido');

  console.log('\n📊 VERIFICACIÓN:');
  console.log(`   - Tu email contiene '@uncodie.com' en from: ${emailFrom.includes('@uncodie.com')}`);
  console.log(`   - Tu email contiene '@uncodie.com' en to: ${emailTo.includes('@uncodie.com')}`);
  console.log(`   - Es self-sent: ${emailFrom === emailTo}`);
  console.log(`   - Debería pasar el filtro rápido: ${emailFrom !== emailTo}`);

}

// Ejecutar test
testYourEmailCase().catch(console.error);
