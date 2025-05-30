import dotenv from 'dotenv';
import crypto from 'crypto';
import { createHash } from 'crypto';

dotenv.config({ path: '.env.local' });

// Misma lógica que ApiKeyService
class TestEncryption {
  static encryptApiKey(apiKey) {
    const encryptionKey = process.env.ENCRYPTION_KEY;
    
    if (!encryptionKey) {
      throw new Error("Missing ENCRYPTION_KEY environment variable");
    }
    
    console.log('Encrypting with key length:', encryptionKey.length);
    
    // Create key and IV from the encryption key
    const key = createHash('sha256').update(String(encryptionKey)).digest();
    const iv = createHash('sha256').update(key).digest().subarray(0, 16);
    
    // Create cipher
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    
    // Encrypt
    let encrypted = cipher.update(Buffer.from(apiKey, 'utf8'));
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    
    // Return only the encrypted value in base64
    return encrypted.toString('base64');
  }

  static decryptApiKey(encryptedKey) {
    const encryptionKey = process.env.ENCRYPTION_KEY;
    
    if (!encryptionKey) {
      throw new Error("Missing ENCRYPTION_KEY environment variable");
    }
    
    try {
      // Create key and IV from the encryption key (same as in encryption)
      const key = createHash('sha256').update(String(encryptionKey)).digest();
      const iv = createHash('sha256').update(key).digest().subarray(0, 16);
      
      // Convert from base64
      const encryptedBuffer = Buffer.from(encryptedKey, 'base64');
      
      // Create decipher
      const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
      
      // Decrypt
      let decrypted = decipher.update(encryptedBuffer);
      decrypted = Buffer.concat([decrypted, decipher.final()]);
      
      return decrypted.toString('utf8');
    } catch (error) {
      console.error('Error decrypting key:', error);
      throw new Error("Invalid encrypted key format");
    }
  }
}

// Test
async function testEncryption() {
  console.log('=== Testing API Key Encryption/Decryption ===\n');
  
  const testApiKey = process.argv[2] || 'key_cUWYo2lJS9NgLZpHJUU73CSYDtzdaP6TxsOm5IEyzRY';
  
  console.log('1. Original API Key:', testApiKey);
  console.log('   Length:', testApiKey.length);
  console.log('   Prefix:', testApiKey.split('_')[0]);
  console.log('');
  
  try {
    // Test encryption
    console.log('2. Encrypting...');
    const encrypted = TestEncryption.encryptApiKey(testApiKey);
    console.log('   Encrypted:', encrypted);
    console.log('   Encrypted Length:', encrypted.length);
    console.log('');
    
    // Test decryption
    console.log('3. Decrypting...');
    const decrypted = TestEncryption.decryptApiKey(encrypted);
    console.log('   Decrypted:', decrypted);
    console.log('   Decrypted Length:', decrypted.length);
    console.log('');
    
    // Verify match
    console.log('4. Verification:');
    console.log('   Match:', decrypted === testApiKey ? '✅ SUCCESS' : '❌ FAILED');
    console.log('   Original === Decrypted:', decrypted === testApiKey);
    
    if (decrypted !== testApiKey) {
      console.log('   Difference detected!');
      console.log('   Original bytes:', Buffer.from(testApiKey).toString('hex'));
      console.log('   Decrypted bytes:', Buffer.from(decrypted).toString('hex'));
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error('   Stack:', error.stack);
  }
  
  console.log('\n=== Environment Check ===');
  console.log('ENCRYPTION_KEY exists:', !!process.env.ENCRYPTION_KEY);
  console.log('ENCRYPTION_KEY length:', process.env.ENCRYPTION_KEY?.length || 0);
  console.log('NODE_ENV:', process.env.NODE_ENV);
}

testEncryption(); 