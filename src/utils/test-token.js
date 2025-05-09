// Utilidad para probar desencriptación de tokens
import CryptoJS from 'crypto-js';

// Token de prueba (formato salt:encrypted)
const encryptedToken = "fb5932583790254357fab69f35e84645:U2FsdGVkX19UsJWdON5EVzcTUgNEnoYClcTdvPuoQwVsWAbJIcqffSXxVqcEY9fY";
const parts = encryptedToken.split(':');
const salt = parts[0];
const encrypted = parts[1];

// Valor de clave de prueba
// Prueba con diferentes valores de clave
const ENCRYPTION_KEYS = [
  '538', // Primeros 3 caracteres de la clave original (60 chars)
  '53864awt96', // Primeros 10 caracteres de la clave combinada
  'Encryption-key' // Clave real usada en el código original
];

console.log(`Testing decryption of token: ${encryptedToken}`);
console.log(`Salt: ${salt}`);
console.log(`Encrypted: ${encrypted}`);

// Probar con cada clave
for (const key of ENCRYPTION_KEYS) {
  console.log(`\nTrying with key: "${key}"`);
  
  try {
    // Crear la clave combinada (clave + salt)
    const combinedKey = key + salt;
    console.log(`Combined key: "${combinedKey.substring(0, 10)}..."`);
    
    // Intentar desencriptar
    const decrypted = CryptoJS.AES.decrypt(encrypted, combinedKey);
    const decryptedText = decrypted.toString(CryptoJS.enc.Utf8);
    
    if (decryptedText) {
      console.log(`SUCCESS! Decrypted value: "${decryptedText}"`);
    } else {
      console.log(`Failed: Empty result`);
    }
  } catch (error) {
    console.log(`Failed: ${error.message}`);
  }
}

// Prueba adicional con la clave exacta de Encryption-key
console.log("\nTrying exact implementation from original code:");
const exactKey = 'Encryption-key';
try {
  const decrypted = CryptoJS.AES.decrypt(encrypted, exactKey + salt);
  const result = decrypted.toString(CryptoJS.enc.Utf8);
  console.log(`Result: ${result || 'Empty result'}`);
} catch (error) {
  console.log(`Error: ${error.message}`);
} 