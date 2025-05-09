/**
 * Script to display API keys and secrets
 * 
 * Run this script with:
 * npx ts-node src/scripts/show-api-keys.ts
 */

import { API_KEYS } from '../lib/api-keys';

console.log('\n=== API KEYS FOR OTHER SERVER ===\n');
console.log(`API Key: ${API_KEYS.otherServer.key}`);
console.log(`API Secret: ${API_KEYS.otherServer.secret}`);
console.log('\nAdd these to your other server configuration.\n');
console.log('Example usage with fetch:');
console.log(`
fetch('http://localhost:3000/api/analyze', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': '${API_KEYS.otherServer.key}',
    'x-api-secret': '${API_KEYS.otherServer.secret}'
  },
  body: JSON.stringify({
    url: 'https://example.com'
  })
})
.then(response => response.json())
.then(data => console.log(data))
.catch(error => console.error('Error:', error));
`); 