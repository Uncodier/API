#!/usr/bin/env node

/**
 * Test script for token encryption endpoint
 * 
 * Usage:
 * node test-token-encrypt.js <value> <site_id> <token_type> [identifier] [store_in_db]
 */

const fetch = require('node-fetch');

async function testTokenEncryption() {
  try {
    // Get command line arguments
    const args = process.argv.slice(2);
    
    if (args.length < 3) {
      console.error('Usage: node test-token-encrypt.js <value> <site_id> <token_type> [identifier] [store_in_db]');
      process.exit(1);
    }
    
    const [value, site_id, token_type, identifier, store_in_db] = args;
    
    console.log('Testing token encryption with:');
    console.log(`- Value: ${value}`);
    console.log(`- Site ID: ${site_id}`);
    console.log(`- Token Type: ${token_type}`);
    if (identifier) {
      console.log(`- Identifier: ${identifier}`);
    }
    console.log(`- Store in DB: ${store_in_db === 'true' ? 'Yes' : 'No'}`);
    
    // Determine base URL (default to localhost)
    const baseUrl = process.env.NEXT_PUBLIC_ORIGIN || process.env.VERCEL_URL || process.env.API_BASE_URL || 'http://localhost:3000';
    const url = new URL('/api/secure-tokens/encrypt', baseUrl).toString();
    
    console.log(`\nSending request to: ${url}`);
    
    // Build request payload
    const payload = {
      value,
      site_id,
      token_type,
      store_in_db: store_in_db === 'true',
    };
    
    if (identifier) {
      payload.identifier = identifier;
    }
    
    // Send request
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    
    // Parse response
    const data = await response.json();
    
    // Display results
    console.log('\n--- RESPONSE ---');
    console.log(`Status: ${response.status} ${response.statusText}`);
    console.log('Headers:', response.headers.raw());
    console.log('Body:', JSON.stringify(data, null, 2));
    
    if (data.success && data.data.encrypted_value) {
      console.log('\n--- ENCRYPTED TOKEN VALUE ---');
      console.log(data.data.encrypted_value);
      
      // Test immediate decryption
      console.log('\nTesting immediate decryption of the encrypted value...');
      
      const decryptUrl = new URL('/api/secure-tokens/decrypt', baseUrl).toString();
      const decryptPayload = {
        site_id,
        token_type,
      };
      
      if (identifier) {
        decryptPayload.identifier = identifier;
      }
      
      if (store_in_db === 'true') {
        console.log('Decrypting from database...');
        
        const decryptResponse = await fetch(decryptUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(decryptPayload),
        });
        
        const decryptData = await decryptResponse.json();
        
        console.log('\n--- DECRYPTION RESPONSE ---');
        console.log(`Status: ${decryptResponse.status} ${decryptResponse.statusText}`);
        console.log('Body:', JSON.stringify(decryptData, null, 2));
        
        if (decryptData.success && decryptData.data.tokenValue) {
          console.log('\n--- DECRYPTED VALUE ---');
          if (typeof decryptData.data.tokenValue === 'object') {
            console.log(JSON.stringify(decryptData.data.tokenValue, null, 2));
          } else {
            console.log(decryptData.data.tokenValue);
          }
          
          // Verify
          console.log('\n--- VERIFICATION ---');
          console.log(`Original value: ${value}`);
          console.log(`Decrypted value: ${decryptData.data.tokenValue}`);
          console.log(`Match: ${value === decryptData.data.tokenValue ? 'YES ✅' : 'NO ❌'}`);
        }
      }
    }
    
  } catch (error) {
    console.error('Error running test:', error);
    process.exit(1);
  }
}

// Run the test
testTokenEncryption(); 