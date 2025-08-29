/**
 * Script para verificar la configuración de aliases
 */

console.log('🔍 Verificando configuración de aliases...\n');

// Simular verificación de configuración
const aliasConfig = {
  aliases: ['hola@uncodie.com', 'ventas@uncodie.com'],
  siteId: 'test-site'
};

console.log('📋 Configuración actual:');
console.log(`  - Site ID: ${aliasConfig.siteId}`);
console.log(`  - Aliases configurados: [${aliasConfig.aliases.join(', ')}]`);
console.log('');

// Verificar el email de prueba
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
console.log('');

// Verificar si el email coincide con los aliases
const isToAlias = aliasConfig.aliases.includes(testEmail.to);
console.log('🔍 Verificación de alias:');
console.log(`  - Email TO: ${testEmail.to}`);
console.log(`  - Está en aliases: ${isToAlias ? '✅' : '❌'}`);

if (isToAlias) {
  console.log('   ✅ El email debería ser procesado como email a alias');
} else {
  console.log('   ❌ El email NO será procesado como email a alias');
  console.log(`   💡 Agregar "${testEmail.to}" a la configuración de aliases`);
}

console.log('\n📊 RESUMEN:');
console.log(`   - Aliases configurados: ${aliasConfig.aliases.length}`);
console.log(`   - Email coincide con alias: ${isToAlias ? '✅' : '❌'}`);
console.log(`   - Procesamiento esperado: ${isToAlias ? 'Email a alias' : 'Email normal'}`);

if (!isToAlias) {
  console.log('\n🚨 PROBLEMA IDENTIFICADO:');
  console.log(`   El email "${testEmail.to}" no está configurado como alias`);
  console.log(`   Solución: Agregar "${testEmail.to}" a la configuración de aliases`);
}
