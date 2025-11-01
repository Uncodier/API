// Utility for testing token decryption
// Accepts encrypted token and encryption keys as command-line arguments or environment variables
// Usage: node test-token.js <encrypted_token> [encryption_key]
// Or set TEST_ENCRYPTED_TOKEN and TEST_ENCRYPTION_KEY environment variables

import CryptoJS from 'crypto-js';

// Get test data from command-line arguments or environment variables
const encryptedToken = process.argv[2] || process.env.TEST_ENCRYPTED_TOKEN;
const encryptionKey = process.argv[3] || process.env.TEST_ENCRYPTION_KEY || process.env.ENCRYPTION_KEY;

if (!encryptedToken) {
  console.error('❌ Error: Encrypted token is required');
  console.error('Usage: node test-token.js <encrypted_token> [encryption_key]');
  console.error('Or set TEST_ENCRYPTED_TOKEN and TEST_ENCRYPTION_KEY environment variables');
  process.exit(1);
}

if (!encryptionKey) {
  console.error('❌ Error: Encryption key is required');
  console.error('Provide as argument or set TEST_ENCRYPTION_KEY or ENCRYPTION_KEY environment variable');
  process.exit(1);
}

// Validate token format (should be salt:encrypted)
if (!encryptedToken.includes(':')) {
  console.error('❌ Error: Encrypted token must be in format salt:encrypted');
  process.exit(1);
}

const parts = encryptedToken.split(':');
const salt = parts[0];
const encrypted = parts[1];

console.log('Testing decryption of token');
console.log(`Salt: ${salt}`);
console.log(`Encrypted: ${encrypted.substring(0, 20)}...`);
console.log(`Encryption key: ${encryptionKey.substring(0, 5)}...`);

try {
  // Create combined key (encryption key + salt)
  const combinedKey = encryptionKey + salt;
  console.log(`\nCombined key: ${combinedKey.substring(0, 10)}...`);
  
  // Attempt decryption
  const decrypted = CryptoJS.AES.decrypt(encrypted, combinedKey);
  const decryptedText = decrypted.toString(CryptoJS.enc.Utf8);
  
  if (decryptedText) {
    console.log(`\n✅ SUCCESS! Decrypted value: "${decryptedText}"`);
  } else {
    console.log('\n❌ Failed: Decryption produced empty result');
    console.log('This may indicate an incorrect encryption key or corrupted token');
  }
} catch (error) {
  console.error(`\n❌ Failed: ${error.message}`);
  process.exit(1);
}