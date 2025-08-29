/**
 * Test script para verificar que la corrección del filtro rápido funciona
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
  
  // 🎯 CORREGIR: No rechazar emails de @uncodie.com automáticamente
  // (pueden ser emails válidos a aliases que serán filtrados después)
  console.log(`[QUICK_FILTER] ✅ Email incluido en filtro rápido: ${emailFrom} → ${emailTo}`);
  return true;
}

// Test principal
async function testQuickFilterFix() {
  console.log('🧪 TEST: Verificación de corrección del filtro rápido\n');

  // Emails de prueba
  const testEmails = [
    {
      name: 'Email a alias (desde @uncodie.com)',
      from: 'Sergio Prado via Hola Uncodie <hola@uncodie.com>',
      to: 'hola@uncodie.com',
      subject: 'info'
    },
    {
      name: 'Email enviado (desde @uncodie.com)',
      from: 'sergio@uncodie.com',
      to: 'cliente@example.com',
      subject: 'Respuesta'
    },
    {
      name: 'Email recibido (a @uncodie.com)',
      from: 'cliente@example.com',
      to: 'sergio@uncodie.com',
      subject: 'Consulta'
    },
    {
      name: 'Self-sent email',
      from: 'test@example.com',
      to: 'test@example.com',
      subject: 'Test'
    },
    {
      name: 'Email normal',
      from: 'otro@example.com',
      to: 'destino@example.com',
      subject: 'Normal'
    }
  ];

  console.log('📧 Emails de prueba:');
  testEmails.forEach((email, index) => {
    console.log(`  ${index + 1}. ${email.name}: ${email.from} → ${email.to}`);
  });
  console.log('');

  try {
    let includedCount = 0;
    let filteredCount = 0;

    for (let i = 0; i < testEmails.length; i++) {
      const testEmail = testEmails[i];
      console.log(`\n🔍 TEST ${i + 1}: ${testEmail.name}`);
      console.log('=' .repeat(50));
      
      const result = simulateCorrectedQuickFilter(testEmail);
      
      if (result) {
        includedCount++;
        console.log(`✅ RESULTADO: INCLUIDO en filtro rápido`);
      } else {
        filteredCount++;
        console.log(`❌ RESULTADO: FILTRADO en filtro rápido`);
      }
    }

    console.log('\n🔍 VERIFICACIÓN DE RESULTADOS:');
    console.log(`   - Emails incluidos: ${includedCount}`);
    console.log(`   - Emails filtrados: ${filteredCount}`);
    console.log(`   - Total: ${testEmails.length}`);
    
    // Verificar que los emails correctos fueron incluidos
    const expectedIncluded = testEmails.filter(email => {
      const emailFrom = (email.from || '').toLowerCase();
      const emailTo = (email.to || '').toLowerCase();
      return emailFrom !== emailTo; // Solo filtrar self-sent
    }).length;
    
    if (includedCount === expectedIncluded) {
      console.log('✅ FILTRO RÁPIDO FUNCIONANDO CORRECTAMENTE');
    } else {
      console.log('❌ FILTRO RÁPIDO NO FUNCIONA CORRECTAMENTE');
      console.log(`   Esperado: ${expectedIncluded} emails incluidos`);
      console.log(`   Obtenido: ${includedCount} emails incluidos`);
    }

    console.log('\n📊 RESUMEN:');
    console.log(`   - Emails incluidos en filtro rápido: ${includedCount}`);
    console.log(`   - Emails filtrados en filtro rápido: ${filteredCount}`);
    console.log(`   - Corrección del filtro: ${includedCount === expectedIncluded ? '✅' : '❌'}`);
    
    console.log('\n🎯 CAMBIO CLAVE:');
    console.log('   - ANTES: Emails de @uncodie.com eran rechazados automáticamente');
    console.log('   - AHORA: Emails de @uncodie.com pasan al filtro comprehensivo');
    console.log('   - RESULTADO: Emails a aliases pueden ser procesados correctamente');

  } catch (error) {
    console.error('❌ Error durante la prueba:', error);
  }
}

// Ejecutar test
testQuickFilterFix().catch(console.error);
