/**
 * Script para verificar la implementación de desencriptación de tokens
 * Genera un token de prueba encriptado y luego lo desencripta
 */
import crypto from 'crypto';

// Constantes de configuración
const ENCRYPTION_KEY = 'Encryption-key'; // Usada en el código original
const PASSWORD_TO_ENCRYPT = 'prueba123'; // Contraseña de prueba a encriptar

// Función para encriptar similar a la del código original
function encryptToken(text) {
  // Generar un salt aleatorio (128 bits = 16 bytes)
  const salt = crypto.randomBytes(16).toString('hex');
  console.log(`Salt generado: ${salt}`);
  
  // Combinar la clave con el salt
  const key = ENCRYPTION_KEY + salt;
  console.log(`Clave derivada: ${key.substring(0, 15)}...`);
  
  // Encriptar con AES usando CryptoJS
  console.log(`Encriptando texto: "${text}"`);
  
  // Primero creamos el salt interno para formato OpenSSL/CryptoJS
  const internalSalt = crypto.randomBytes(8);
  console.log(`Salt interno generado: ${internalSalt.toString('hex')}`);
  
  // Derivar clave e IV
  const keyMaterial = deriveKeyAndIv(key, internalSalt);
  
  // Crear formato "Salted__" + salt + ciphertext
  const saltedPrefix = Buffer.from('Salted__');
  
  // Cifrar con AES-256-CBC
  const cipher = crypto.createCipheriv('aes-256-cbc', keyMaterial.key, keyMaterial.iv);
  let encrypted = cipher.update(text, 'utf-8');
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  
  // Combinar salt y datos encriptados en formato OpenSSL
  const encryptedWithSalt = Buffer.concat([saltedPrefix, internalSalt, encrypted]);
  
  // Convertir a base64
  const encryptedBase64 = encryptedWithSalt.toString('base64');
  console.log(`Texto encriptado (base64): ${encryptedBase64}`);
  
  // El valor final almacenado: salt:encrypted
  return `${salt}:${encryptedBase64}`;
}

// Función para derivar clave e IV desde una contraseña y salt
function deriveKeyAndIv(password, salt) {
  const keySize = 32; // Tamaño de clave para AES-256
  const ivSize = 16;  // Tamaño del IV
  
  let derivedBytes = Buffer.alloc(0);
  
  // Convertir la contraseña a buffer si es string
  const passwordBuffer = typeof password === 'string' ? Buffer.from(password) : password;
  
  // OpenSSL/CryptoJS usa una técnica de derivación basada en MD5
  // con concatenación de hashes previos
  let preHashedData = Buffer.alloc(0);
  
  // Generar suficientes bytes para clave e IV
  while (derivedBytes.length < keySize + ivSize) {
    const md5 = crypto.createHash('md5');
    
    // Si no es la primera iteración, incluir el hash anterior
    if (preHashedData.length > 0) {
      md5.update(preHashedData);
    }
    
    // Incluir la contraseña y salt
    md5.update(passwordBuffer);
    
    if (salt) {
      md5.update(salt);
    }
    
    // Obtener el digest y guardarlo para la próxima iteración
    preHashedData = md5.digest();
    
    // Añadir al material de clave acumulado
    derivedBytes = Buffer.concat([derivedBytes, preHashedData]);
  }
  
  // Dividir el material derivado en clave e IV
  return {
    key: derivedBytes.slice(0, keySize),
    iv: derivedBytes.slice(keySize, keySize + ivSize)
  };
}

// Función para desencriptar, implementando lógica corregida
function decryptToken(encryptedValue) {
  try {
    // Separar salt y encrypted
    const parts = encryptedValue.split(':');
    if (parts.length !== 2) {
      throw new Error('Invalid format, expected salt:encrypted');
    }
    
    const salt = parts[0];
    const encryptedBase64 = parts[1];
    console.log(`Salt extraído: ${salt}`);
    
    // Crear clave combinada
    const key = ENCRYPTION_KEY + salt;
    
    // Decodificar el contenido base64
    const encryptedData = Buffer.from(encryptedBase64, 'base64');
    
    // Verificar formato CryptoJS/OpenSSL
    if (encryptedData.slice(0, 8).toString() === 'Salted__') {
      console.log('Detectado formato OpenSSL/CryptoJS');
      
      // Extraer salt interno
      const saltFromData = encryptedData.slice(8, 16);
      console.log(`Salt interno: ${saltFromData.toString('hex')}`);
      
      // Derivar clave e IV
      const keyMaterial = deriveKeyAndIv(key, saltFromData);
      
      // Obtener ciphertext
      const ciphertext = encryptedData.slice(16);
      
      // Descifrar
      const decipher = crypto.createDecipheriv('aes-256-cbc', keyMaterial.key, keyMaterial.iv);
      let decrypted = decipher.update(ciphertext);
      decrypted = Buffer.concat([decrypted, decipher.final()]);
      
      return decrypted.toString('utf8');
    } else {
      throw new Error('Formato no reconocido, se esperaba "Salted__"');
    }
  } catch (error) {
    console.error(`Error desencriptando: ${error.message}`);
    return null;
  }
}

// Prueba 1: Generar un token encriptado y desencriptarlo
console.log("=".repeat(50));
console.log("PRUEBA 1: Encriptar y desencriptar token generado");
console.log("=".repeat(50));
const encryptedToken = encryptToken(PASSWORD_TO_ENCRYPT);
console.log(`\nToken encriptado completo:\n${encryptedToken}`);

console.log("\nIntentando desencriptar...");
const decryptedValue = decryptToken(encryptedToken);
console.log(`\nValor desencriptado: "${decryptedValue}"`);
console.log(`Verificación: ${decryptedValue === PASSWORD_TO_ENCRYPT ? '✅ EXITOSA' : '❌ FALLIDA'}`);

// Prueba 2: Desencriptar un token existente
console.log("\n" + "=".repeat(50));
console.log("PRUEBA 2: Desencriptar token del sistema real");
console.log("=".repeat(50));

const existingToken = "fb5932583790254357fab69f35e84645:U2FsdGVkX19UsJWdON5EVzcTUgNEnoYClcTdvPuoQwVsWAbJIcqffSXxVqcEY9fY";
console.log(`Token existente: ${existingToken}`);

console.log("\nIntentando desencriptar...");
const decryptedExisting = decryptToken(existingToken);
console.log(`\nValor desencriptado: "${decryptedExisting}"`);

// Verificar resultados
console.log("\n" + "=".repeat(50));
console.log("RESULTADOS FINALES");
console.log("=".repeat(50));
console.log(`Token aleatorio generado: ✅ ${decryptedValue === PASSWORD_TO_ENCRYPT ? 'EXITOSO' : 'FALLIDO'}`);
console.log(`Token real del sistema: ${decryptedExisting ? '✅ EXITOSO' : '❌ FALLIDO'}`);
if (decryptedExisting) {
  console.log(`Valor obtenido del token real: "${decryptedExisting}"`);
} 