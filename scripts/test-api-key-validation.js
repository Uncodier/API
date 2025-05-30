import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

async function testApiKeyValidation() {
  const apiUrl = process.env.API_URL || 'http://localhost:3001';
  const testApiKey = process.argv[2];
  
  if (!testApiKey) {
    console.error('Usage: node scripts/test-api-key-validation.js <api-key>');
    process.exit(1);
  }

  console.log('Testing API Key validation...');
  console.log('API URL:', apiUrl);
  console.log('API Key:', testApiKey.substring(0, 10) + '...');
  console.log('NODE_ENV:', process.env.NODE_ENV);
  console.log('');

  try {
    // Test 1: With x-api-key header
    console.log('Test 1: Using x-api-key header');
    const response1 = await fetch(`${apiUrl}/api/status`, {
      headers: {
        'x-api-key': testApiKey,
      }
    });
    
    console.log('Response status:', response1.status);
    const data1 = await response1.json();
    console.log('Response:', JSON.stringify(data1, null, 2));
    console.log('');

    // Test 2: With Authorization header
    console.log('Test 2: Using Authorization header');
    const response2 = await fetch(`${apiUrl}/api/status`, {
      headers: {
        'Authorization': `Bearer ${testApiKey}`,
      }
    });
    
    console.log('Response status:', response2.status);
    const data2 = await response2.json();
    console.log('Response:', JSON.stringify(data2, null, 2));
    
  } catch (error) {
    console.error('Error:', error.message);
  }
}

testApiKeyValidation(); 