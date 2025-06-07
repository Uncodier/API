/**
 * Script de prueba para verificar la configuración de Temporal
 * 
 * Ejecutar con: node test-temporal-config.js
 */

const { WorkflowService } = require('./src/lib/services/workflow-service.ts');

async function testTemporalConfiguration() {
  console.log('🧪 Iniciando prueba de configuración de Temporal...\n');
  
  try {
    const workflowService = WorkflowService.getInstance();
    
    // 1. Verificar configuración
    console.log('📋 1. Verificando configuración...');
    const configReport = workflowService.getConfigurationReport();
    
    console.log(`   Tipo de deployment: ${configReport.deploymentType.toUpperCase()}`);
    console.log(`   Servidor: ${configReport.serverUrl}`);
    console.log(`   Namespace: ${configReport.namespace}`);
    console.log(`   API Key configurado: ${configReport.apiKeyConfigured ? 'Sí' : 'No'}`);
    
    if (configReport.environment) {
      console.log(`   Entorno: ${configReport.environment.toUpperCase()}`);
      if (configReport.forcedByEnvironment) {
        console.log('   🎯 Configuración forzada por TEMPORAL_ENV');
      }
    }
    
    if (configReport.validation.errors.length > 0) {
      console.log('   ❌ Errores de configuración:');
      configReport.validation.errors.forEach(error => {
        console.log(`      - ${error}`);
      });
    }
    
    if (configReport.validation.warnings.length > 0) {
      console.log('   ⚠️ Advertencias:');
      configReport.validation.warnings.forEach(warning => {
        console.log(`      - ${warning}`);
      });
    }
    
    if (configReport.recommendations.length > 0) {
      console.log('   💡 Recomendaciones:');
      configReport.recommendations.forEach(rec => {
        console.log(`      - ${rec}`);
      });
    }
    
    // 2. Auto-detección
    console.log('\n🔍 2. Auto-detección de configuración...');
    const autoConfig = workflowService.getAutoDetectedConfiguration();
    
    console.log(`   Tipo sugerido: ${autoConfig.suggestedType.toUpperCase()}`);
    console.log('   Configuración sugerida:');
    Object.entries(autoConfig.suggestedSettings).forEach(([key, value]) => {
      console.log(`      ${key}=${value}`);
    });
    
    if (autoConfig.reasoning.length > 0) {
      console.log('   Razonamiento:');
      autoConfig.reasoning.forEach(reason => {
        console.log(`      - ${reason}`);
      });
    }
    
    // 3. Prueba de conexión
    console.log('\n🔌 3. Probando conexión...');
    const connectionTest = await workflowService.testConnection();
    
    if (connectionTest.success) {
      console.log('   ✅ Conexión exitosa');
      if (connectionTest.config) {
        console.log(`   Tipo confirmado: ${connectionTest.config.deploymentType.toUpperCase()}`);
      }
    } else {
      console.log('   ❌ Error de conexión:');
      console.log(`      ${connectionTest.error}`);
    }
    
    // 4. Resumen
    console.log('\n📊 Resumen:');
    if (configReport.validation.isValid && connectionTest.success) {
      console.log('   ✅ Configuración válida y conexión exitosa');
      console.log('   🚀 Temporal está listo para usar');
    } else if (configReport.validation.isValid && !connectionTest.success) {
      console.log('   ⚠️ Configuración válida pero sin conexión');
      console.log('   🔧 Verifica que el servidor Temporal esté ejecutándose');
    } else {
      console.log('   ❌ Configuración inválida');
      console.log('   📝 Revisa las variables de entorno');
    }
    
  } catch (error) {
    console.error('❌ Error en la prueba:', error.message);
    console.error('📍 Stack trace:', error.stack);
  }
  
  console.log('\n🏁 Prueba completada.');
}

// Ejecutar prueba
if (require.main === module) {
  testTemporalConfiguration().catch(console.error);
}

module.exports = { testTemporalConfiguration }; 