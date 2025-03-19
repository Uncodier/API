/**
 * Simple script to generate and display API keys and secrets
 * 
 * Run with: node src/lib/api-keys-display.js
 */

// Generate a random string for API key and secret
const generateRandomString = (length) => {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  const charactersLength = characters.length;
  for (let i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * charactersLength));
  }
  return result;
};

// Generate API key and secret
const apiKey = 'sa-' + generateRandomString(24);
const apiSecret = 'ss-' + generateRandomString(32);

console.log('\n=== API KEYS FOR OTHER SERVER ===\n');
console.log(`API Key: ${apiKey}`);
console.log(`API Secret: ${apiSecret}`);
console.log('\nAdd these to your other server configuration.\n');
console.log('Example usage with fetch:');
console.log(`
fetch('http://localhost:3000/api/analyze', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': '${apiKey}',
    'x-api-secret': '${apiSecret}'
  },
  body: JSON.stringify({
    url: 'https://example.com'
  })
})
.then(response => response.json())
.then(data => console.log(data))
.catch(error => console.error('Error:', error));
`); 