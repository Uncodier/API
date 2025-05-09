#!/usr/bin/env node

/**
 * Test script for token decryption endpoint
 * 
 * Usage:
 * node test-token-decrypt.js <site_id> <token_type> [identifier]
 */

const fetch = require('node-fetch');

async function testTokenDecryption() {
  try {
    // Get command line arguments
    const args = process.argv.slice(2);
    
    if (args.length < 2) {
      console.error('Usage: node test-token-decrypt.js <site_id> <token_type> [identifier]');
      process.exit(1);
    }
    
    const [site_id, token_type, identifier] = args;
    
    console.log('Testing token decryption with:');
    console.log(`- Site ID: ${site_id}`);
    console.log(`- Token Type: ${token_type}`);
    if (identifier) {
      console.log(`- Identifier: ${identifier}`);
    }
    
    // Determine base URL (default to localhost)
    const baseUrl = process.env.NEXT_PUBLIC_ORIGIN || process.env.VERCEL_URL || process.env.API_BASE_URL || 'http://localhost:3000';
    const url = new URL('/api/secure-tokens/decrypt', baseUrl).toString();
    
    console.log(`\nSending request to: ${url}`);
    
    // Build request payload
    const payload = {
      site_id,
      token_type,
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
    
    if (data.success && data.data.tokenValue) {
      console.log('\n--- DECRYPTED TOKEN VALUE ---');
      if (typeof data.data.tokenValue === 'object') {
        console.log(JSON.stringify(data.data.tokenValue, null, 2));
      } else {
        console.log(data.data.tokenValue);
      }
    }
    
  } catch (error) {
    console.error('Error running test:', error);
    process.exit(1);
  }
}

// Run the test
testTokenDecryption(); 