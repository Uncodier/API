#!/usr/bin/env node

/**
 * Script de prueba para la API de NeverBounce
 * 
 * Uso: node scripts/test-neverbounce-api.mjs [email]
 * 
 * Si no se proporciona email, usa un email de prueba por defecto.
 */

import fetch from 'node-fetch';

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';
const TEST_EMAIL = process.argv[2] || 'support@neverbounce.com';

console.log('🧪 Testing NeverBounce Email Validation API');
console.log('='.repeat(50));

async function testGetInfo() {
  console.log('\n📋 1. Testing service information...');
  
  try {
    const response = await fetch(`${API_BASE_URL}/api/integrations/neverbounce/validate`, {
      method: 'GET'
    });
    
    const result = await response.json();
    
    console.log(`Status: ${response.status}`);
    if (result.success) {
      console.log(`Service: ${result.data.service}`);
      console.log(`Version: ${result.data.version}`);
      console.log(`Configuration Status: ${result.data.status}`);
    } else {
      console.log(`Error: ${result.error?.message || 'Unknown error'}`);
    }
    
    return response.ok;
  } catch (error) {
    console.error('❌ Error getting service info:', error.message);
    return false;
  }
}

async function testEmailValidation(email) {
  console.log(`\n✉️  2. Testing email validation for: ${email}`);
  
  try {
    const startTime = Date.now();
    
    const response = await fetch(`${API_BASE_URL}/api/integrations/neverbounce/validate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email })
    });
    
    const result = await response.json();
    const endTime = Date.now();
    
    console.log(`Status: ${response.status}`);
    console.log(`Response time: ${endTime - startTime}ms`);
    
    if (response.ok && result.success) {
      console.log(`Email: ${result.data.email}`);
      console.log(`Is Valid: ${result.data.isValid ? '✅' : '❌'}`);
      console.log(`Result: ${result.data.result}`);
      console.log(`Message: ${result.data.message}`);
      
      if (result.data.flags && result.data.flags.length > 0) {
        console.log(`Flags: ${result.data.flags.join(', ')}`);
      }
      
      if (result.data.suggested_correction) {
        console.log(`Suggested Correction: ${result.data.suggested_correction}`);
      }
      
      console.log(`Execution Time: ${result.data.execution_time}ms`);
    } else {
      console.log(`❌ Error: ${result.error?.message || 'Unknown error'}`);
      console.log(`Details: ${result.error?.details || 'No details provided'}`);
    }
    
    return response.ok;
  } catch (error) {
    console.error('❌ Error validating email:', error.message);
    return false;
  }
}

async function testInvalidEmail() {
  console.log('\n🚫 3. Testing invalid email format...');
  
  try {
    const response = await fetch(`${API_BASE_URL}/api/integrations/neverbounce/validate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email: 'not-an-email' })
    });
    
    const result = await response.json();
    
    console.log(`Status: ${response.status}`);
    if (result.success) {
      console.log(`Is Valid: ${result.data.isValid ? '✅' : '❌'}`);
      console.log(`Result: ${result.data.result}`);
      console.log(`Message: ${result.data.message}`);
      return response.status === 200 && !result.data.isValid;
    } else {
      console.log(`Error: ${result.error?.message || 'Unknown error'}`);
      return false;
    }
  } catch (error) {
    console.error('❌ Error testing invalid email:', error.message);
    return false;
  }
}

async function testMissingEmail() {
  console.log('\n❓ 4. Testing missing email parameter...');
  
  try {
    const response = await fetch(`${API_BASE_URL}/api/integrations/neverbounce/validate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({})
    });
    
    const result = await response.json();
    
    console.log(`Status: ${response.status}`);
    if (result.success === false) {
      console.log(`Error Code: ${result.error.code}`);
      console.log(`Error: ${result.error.message}`);
      console.log(`Details: ${result.error.details}`);
      return response.status === 400;
    } else {
      console.log(`Unexpected success response`);
      return false;
    }
  } catch (error) {
    console.error('❌ Error testing missing email:', error.message);
    return false;
  }
}

async function runAllTests() {
  console.log(`🎯 Testing API at: ${API_BASE_URL}`);
  console.log(`📧 Test email: ${TEST_EMAIL}`);
  
  const results = {
    getInfo: await testGetInfo(),
    emailValidation: await testEmailValidation(TEST_EMAIL),
    invalidEmail: await testInvalidEmail(),
    missingEmail: await testMissingEmail()
  };
  
  console.log('\n📊 Test Results Summary:');
  console.log('='.repeat(30));
  console.log(`Service Info: ${results.getInfo ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`Email Validation: ${results.emailValidation ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`Invalid Email Handling: ${results.invalidEmail ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`Missing Email Handling: ${results.missingEmail ? '✅ PASS' : '❌ FAIL'}`);
  
  const passCount = Object.values(results).filter(Boolean).length;
  const totalTests = Object.keys(results).length;
  
  console.log(`\n🎉 Tests passed: ${passCount}/${totalTests}`);
  
  if (passCount === totalTests) {
    console.log('✅ All tests passed! NeverBounce API is working correctly.');
    process.exit(0);
  } else {
    console.log('❌ Some tests failed. Check the logs above for details.');
    process.exit(1);
  }
}

// Verificar si el servidor está corriendo
console.log('🔍 Checking if server is running...');

try {
  const healthCheck = await fetch(`${API_BASE_URL}/api/status`).catch(() => null);
  
  if (!healthCheck) {
    console.log('⚠️  Server might not be running. Make sure to start the development server:');
    console.log('   npm run dev');
    console.log('\nContinuing with tests anyway...\n');
  } else {
    console.log('✅ Server is running\n');
  }
  
  await runAllTests();
} catch (error) {
  console.error('💥 Fatal error:', error.message);
  process.exit(1);
}