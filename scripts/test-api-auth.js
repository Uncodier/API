#!/usr/bin/env node

/**
 * Script para probar el sistema de autenticación de la API
 * 
 * Uso:
 *   node scripts/test-api-auth.js
 *   node scripts/test-api-auth.js https://api.example.com
 */

const API_URL = process.argv[2] || 'http://localhost:3000';
const SERVICE_API_KEY = process.env.SERVICE_API_KEY || 'test-service-key';

console.log('🧪 Probando sistema de autenticación de API');
console.log(`📍 URL: ${API_URL}`);
console.log('');

async function testEndpoint(name, options = {}) {
  try {
    console.log(`\n📋 Test: ${name}`);
    console.log('Request:', options);
    
    const response = await fetch(`${API_URL}/api/status`, options);
    const data = await response.json();
    
    console.log('Status:', response.status);
    console.log('Auth Method:', data.authentication?.authMethod || 'Unknown');
    console.log('Has API Key:', data.authentication?.hasApiKey || false);
    
    if (data.authentication?.apiKeyInfo) {
      console.log('API Key Info:', {
        id: data.authentication.apiKeyInfo.id,
        name: data.authentication.apiKeyInfo.name,
        isService: data.authentication.apiKeyInfo.isService,
      });
    }
    
    if (response.status !== 200) {
      console.log('❌ Error:', data.error || data);
    } else {
      console.log('✅ Success');
    }
    
    return { success: response.status === 200, data };
  } catch (error) {
    console.log('❌ Request failed:', error.message);
    return { success: false, error };
  }
}

async function runTests() {
  // Test 1: Sin autenticación (simulando servidor)
  console.log('\n🔹 Test 1: Sin autenticación (petición servidor sin API key)');
  await testEndpoint('No auth - Server request', {
    headers: {
      'Content-Type': 'application/json',
    },
  });

  // Test 2: Con origin (simulando navegador)
  console.log('\n🔹 Test 2: Con origin (simulando navegador)');
  await testEndpoint('With origin - Browser request', {
    headers: {
      'Content-Type': 'application/json',
      'Origin': 'http://localhost:3001',
    },
  });

  // Test 3: Con x-api-key
  console.log('\n🔹 Test 3: Con x-api-key');
  await testEndpoint('With x-api-key', {
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': SERVICE_API_KEY,
    },
  });

  // Test 4: Con Authorization Bearer
  console.log('\n🔹 Test 4: Con Authorization Bearer');
  await testEndpoint('With Authorization Bearer', {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SERVICE_API_KEY}`,
    },
  });

  // Test 5: Con Authorization directo
  console.log('\n🔹 Test 5: Con Authorization directo');
  await testEndpoint('With Authorization direct', {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': SERVICE_API_KEY,
    },
  });

  // Test 6: API key inválida
  console.log('\n🔹 Test 6: API key inválida');
  await testEndpoint('Invalid API key', {
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': 'invalid-key-12345',
    },
  });

  console.log('\n\n✨ Tests completados');
}

// Ejecutar tests
runTests().catch(console.error); 