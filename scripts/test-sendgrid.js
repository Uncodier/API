#!/usr/bin/env node
import dotenv from 'dotenv';

// Cargar variables de entorno desde .env.local (como Next.js)
dotenv.config({ path: '.env.local' });
dotenv.config(); // Fallback a .env si no existe .env.local

async function testSendGrid() {
  console.log('🔍 Diagnóstico de SendGrid\n');
  
  // 1. Verificar variables de entorno
  console.log('📋 Variables de entorno:');
  console.log('- SENDGRID_API_KEY:', process.env.SENDGRID_API_KEY ? '✅ Configurada' : '❌ Faltante');
  console.log('- SENDGRID_FROM_EMAIL:', process.env.SENDGRID_FROM_EMAIL || 'no-reply@uncodie.com');
  console.log('- SENDGRID_FROM_NAME:', process.env.SENDGRID_FROM_NAME || 'Uncodie');
  console.log('- NODE_ENV:', process.env.NODE_ENV || 'development');
  
  if (process.env.SENDGRID_API_KEY) {
    console.log('- API Key preview:', process.env.SENDGRID_API_KEY.substring(0, 10) + '...');
  }
  console.log('');
  
  if (!process.env.SENDGRID_API_KEY) {
    console.error('❌ Error: SENDGRID_API_KEY no está configurada en .env.local');
    console.log('💡 Agrega esta línea a tu .env.local:');
    console.log('SENDGRID_API_KEY=tu_api_key_aquí');
    return;
  }
  
  // 2. Importar el servicio dinámicamente
  try {
    console.log('📦 Importando sendGridService...');
    const { sendGridService } = await import('../src/lib/services/sendgrid-service.js');
    console.log('✅ SendGrid service importado correctamente');
    
    // 3. Verificar configuración
    console.log('\n⚙️ Configuración actual:');
    const config = sendGridService.getConfig();
    console.log('- defaultFromEmail:', config.defaultFromEmail);
    console.log('- defaultFromName:', config.defaultFromName);
    console.log('- sandboxMode:', config.sandboxMode);
    
    // 4. Health check
    console.log('\n🏥 Health check...');
    const isHealthy = await sendGridService.healthCheck();
    console.log('- Estado:', isHealthy ? '✅ Saludable' : '❌ No saludable');
    
    // 5. Enviar email de prueba
    console.log('\n📧 Enviando email de prueba...');
    const testEmail = process.argv[2] || 'test@ejemplo.com';
    
    const result = await sendGridService.sendEmail({
      to: testEmail,
      subject: 'Test de SendGrid - ' + new Date().toISOString(),
      html: `
        <h1>Test de SendGrid</h1>
        <p>Este es un email de prueba enviado el ${new Date().toLocaleString()}</p>
        <p><strong>Configuración:</strong></p>
        <ul>
          <li>Sandbox Mode: ${config.sandboxMode}</li>
          <li>From: ${config.defaultFromEmail}</li>
          <li>Environment: ${process.env.NODE_ENV}</li>
        </ul>
      `,
      categories: ['test', 'diagnostic']
    });
    
    console.log('\n📊 Resultado del envío:');
    console.log('- Éxito:', result.success ? '✅' : '❌');
    console.log('- Message ID:', result.messageId || 'N/A');
    console.log('- Status Code:', result.statusCode || 'N/A');
    console.log('- Error:', result.error || 'Ninguno');
    
    if (config.sandboxMode) {
      console.log('\n⚠️  IMPORTANTE: Modo Sandbox está activado');
      console.log('   Los emails NO se envían realmente en modo sandbox.');
      console.log('   Para enviar emails reales, configura NODE_ENV=production');
    }
    
  } catch (error) {
    console.error('❌ Error al probar SendGrid:', error.message);
    if (error.stack) {
      console.error('Stack trace:', error.stack);
    }
    console.log('\n🔧 Posibles soluciones:');
    console.log('1. Verificar que SENDGRID_API_KEY sea correcta en .env.local');
    console.log('2. Verificar conectividad a internet');
    console.log('3. Verificar que el dominio esté verificado en SendGrid');
  }
}

// Ejecutar el diagnóstico
console.log('Uso: node scripts/test-sendgrid.js [email-destino]');
console.log('Ejemplo: node scripts/test-sendgrid.js tu@email.com\n');

testSendGrid(); 