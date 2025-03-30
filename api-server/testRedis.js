// Script simple para probar conexión a Redis
import dotenv from 'dotenv';
import Redis from 'ioredis';

// Cargar variables de entorno
dotenv.config({ path: '.env.local' });

console.log('Iniciando prueba de conexión a Redis...');
console.log(`URL Redis configurada: ${process.env.REDIS_URL ? 'Sí' : 'No'}`);

// Función para ocultar credenciales en URL
function maskRedisUrl(url) {
  return url ? url.replace(/\/\/[^:]+:[^@]+@/, '//***:***@') : 'No disponible';
}

console.log(`URL Redis (enmascarada): ${maskRedisUrl(process.env.REDIS_URL)}`);

// Crear un cliente Redis
const redis = new Redis(process.env.REDIS_URL, {
  connectTimeout: 10000,
  maxRetriesPerRequest: 3
});

redis.on('error', (err) => {
  console.error('❌ Error de conexión Redis:', err.message);
  process.exit(1);
});

redis.on('connect', () => {
  console.log('🔄 Conectando a Redis...');
});

redis.on('ready', async () => {
  console.log('✅ Conexión a Redis exitosa');
  
  try {
    // Intentar guardar un valor de prueba
    const testKey = `test:${Date.now()}`;
    const testValue = 'Test value ' + new Date().toISOString();
    
    console.log(`Intentando guardar valor en clave: ${testKey}`);
    await redis.set(testKey, testValue, 'EX', 60); // Expira en 60 segundos
    
    // Leer el valor guardado
    const retrievedValue = await redis.get(testKey);
    console.log(`Valor recuperado: ${retrievedValue}`);
    
    if (retrievedValue === testValue) {
      console.log('✅ Prueba de escritura/lectura en Redis exitosa');
    } else {
      console.error('❌ Error: El valor recuperado no coincide con el valor guardado');
    }
  } catch (error) {
    console.error('❌ Error en operaciones Redis:', error.message);
  } finally {
    // Cerrar conexión
    await redis.quit();
    console.log('Conexión cerrada, prueba completada');
    process.exit(0);
  }
}); 