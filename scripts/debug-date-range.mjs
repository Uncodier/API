/**
 * Script para debuggear el problema de rango de fechas en la obtención de emails
 */

// Simular la lógica de fechas del EmailService
function simulateDateRange(sinceDate) {
  console.log('🔍 DIAGNÓSTICO DE RANGO DE FECHAS');
  console.log('=' .repeat(50));
  
  const now = new Date();
  console.log(`📅 Fecha actual: ${now.toISOString()}`);
  console.log(`📅 Fecha actual (local): ${now.toString()}`);
  
  if (sinceDate) {
    try {
      const sinceDateTime = new Date(sinceDate);
      if (isNaN(sinceDateTime.getTime())) {
        console.log(`❌ Fecha inválida: ${sinceDate}`);
        return;
      }
      
      console.log(`📅 Fecha since: ${sinceDateTime.toISOString()}`);
      console.log(`📅 Fecha since (local): ${sinceDateTime.toString()}`);
      
      const timeDiff = now.getTime() - sinceDateTime.getTime();
      const hoursDiff = timeDiff / (1000 * 60 * 60);
      const minutesDiff = timeDiff / (1000 * 60);
      
      console.log(`⏰ Diferencia de tiempo: ${hoursDiff.toFixed(2)} horas (${minutesDiff.toFixed(0)} minutos)`);
      
      if (hoursDiff < 0) {
        console.log(`⚠️ ADVERTENCIA: La fecha since está en el futuro!`);
      } else if (hoursDiff < 1) {
        console.log(`⚠️ ADVERTENCIA: Rango muy pequeño (menos de 1 hora)`);
      } else if (hoursDiff > 168) {
        console.log(`⚠️ ADVERTENCIA: Rango muy grande (más de 1 semana)`);
      } else {
        console.log(`✅ Rango de tiempo parece razonable`);
      }
      
    } catch (dateError) {
      console.log(`❌ Error procesando fecha: ${dateError.message}`);
    }
  } else {
    console.log(`📅 No hay fecha since especificada (buscará todos los emails)`);
  }
}

// Simular los intentos de búsqueda del endpoint
function simulateSearchAttempts() {
  console.log('\n🔄 SIMULACIÓN DE INTENTOS DE BÚSQUEDA');
  console.log('=' .repeat(50));
  
  const now = new Date();
  const HOURS_PROGRESSIONS = [24, 48, 168]; // 1 día, 2 días, 1 semana
  
  console.log('📋 Configuración de intentos:');
  console.log(`  - HOURS_PROGRESSIONS: [${HOURS_PROGRESSIONS.join(', ')}]`);
  console.log(`  - Fecha actual: ${now.toISOString()}`);
  console.log('');
  
  for (let i = 0; i < HOURS_PROGRESSIONS.length; i++) {
    const hoursBack = HOURS_PROGRESSIONS[i];
    const searchDate = new Date(now.getTime() - hoursBack * 60 * 60 * 1000);
    
    console.log(`🔄 Intento ${i + 1}:`);
    console.log(`   - Horas hacia atrás: ${hoursBack}`);
    console.log(`   - Fecha de búsqueda: ${searchDate.toISOString()}`);
    console.log(`   - Fecha de búsqueda (local): ${searchDate.toString()}`);
    
    const timeDiff = now.getTime() - searchDate.getTime();
    const hoursDiff = timeDiff / (1000 * 60 * 60);
    console.log(`   - Rango de búsqueda: ${hoursDiff} horas`);
    console.log('');
  }
}

// Test principal
async function debugDateRange() {
  console.log('🧪 DEBUG: Problema de rango de fechas en obtención de emails\n');
  
  // Simular diferentes escenarios
  const scenarios = [
    {
      name: 'Sin fecha since (buscar todos)',
      sinceDate: null
    },
    {
      name: 'Fecha muy reciente (1 hora atrás)',
      sinceDate: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString()
    },
    {
      name: 'Fecha reciente (24 horas atrás)',
      sinceDate: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    },
    {
      name: 'Fecha antigua (1 semana atrás)',
      sinceDate: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    }
  ];
  
  for (const scenario of scenarios) {
    console.log(`\n📋 ESCENARIO: ${scenario.name}`);
    console.log('-'.repeat(40));
    simulateDateRange(scenario.sinceDate);
  }
  
  // Simular intentos de búsqueda
  simulateSearchAttempts();
  
  console.log('\n🎯 POSIBLES PROBLEMAS:');
  console.log('1. 🕐 Problema de zona horaria entre servidor y cliente');
  console.log('2. 📅 Fecha since muy reciente que excluye emails nuevos');
  console.log('3. 🔄 Cache del servidor IMAP no actualizado');
  console.log('4. 📧 Emails no sincronizados en el servidor');
  console.log('5. ⚙️ Configuración IMAP incorrecta');
  
  console.log('\n🔧 RECOMENDACIONES:');
  console.log('1. Verificar logs del endpoint para ver qué fecha since se está usando');
  console.log('2. Probar sin fecha since para obtener todos los emails');
  console.log('3. Verificar configuración de zona horaria del servidor');
  console.log('4. Revisar si hay problemas de autenticación IMAP');
}

// Ejecutar debug
debugDateRange().catch(console.error);
