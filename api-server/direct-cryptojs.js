/**
 * Script de desencriptación directo usando la misma lógica del código proporcionado
 */
import crypto from 'crypto';

// Constantes
const encryptedValue = "fb5932583790254357fab69f35e84645:U2FsdGVkX19UsJWdON5EVzcTUgNEnoYClcTdvPuoQwVsWAbJIcqffSXxVqcEY9fY";
const ENCRYPTION_KEY = 'Encryption-key';

console.log(`Intentando desencriptar usando la implementación exacta del código proporcionado...`);
console.log(`Valor encriptado: ${encryptedValue}`);
console.log(`Clave base: ${ENCRYPTION_KEY}`);

/**
 * Función para desencriptar
 * Implementa exactamente la misma lógica que el código proporcionado
 */
function decryptToken(encryptedValue) {
  try {
    // Extraer salt y valor encriptado
    const [salt, encrypted] = encryptedValue.split(':');
    console.log(`Salt extraído: ${salt}`);
    console.log(`Encrypted extraído: ${encrypted.substring(0, 20)}...`);
    
    // Clave de desencriptación = ENCRYPTION_KEY + salt
    const key = ENCRYPTION_KEY + salt;
    console.log(`Clave para desencriptar: ${key.substring(0, 15)}...`);
    
    // Probar con cualquier posible formato de salida de CryptoJS
    try {
      // Intentamos ejecutar CryptoJS.AES.decrypt(encrypted, key)
      // Primero decodificamos la parte base64 del encrypted
      const encryptedData = Buffer.from(encrypted, 'base64');
      
      // Según el formato de CryptoJS, extraemos las partes
      if (encryptedData.slice(0, 8).toString() === 'Salted__') {
        console.log("Detectado formato 'Salted__' en los datos");
        
        const saltFromData = encryptedData.slice(8, 16);
        console.log(`Salt interno: ${saltFromData.toString('hex')}`);
        
        // Para AES-256, necesitamos derivar una clave de 32 bytes y un IV de 16 bytes
        // CryptoJS usa una técnica de derivación compatible con OpenSSL
        const keyMaterial = deriveKeyAndIv(key, saltFromData);
        
        console.log(`Derivados - Key (32 bytes): ${keyMaterial.key.toString('hex').substring(0, 32)}...`);
        console.log(`Derivados - IV (16 bytes): ${keyMaterial.iv.toString('hex')}`);
        
        // El contenido cifrado real está después del salt
        const ciphertext = encryptedData.slice(16);
        
        // Desciframos usando AES-256-CBC (modo por defecto de CryptoJS)
        const decipher = crypto.createDecipheriv('aes-256-cbc', keyMaterial.key, keyMaterial.iv);
        
        let decryptedBytes = decipher.update(ciphertext);
        decryptedBytes = Buffer.concat([decryptedBytes, decipher.final()]);
        
        // Convertir a UTF-8
        const decryptedText = decryptedBytes.toString('utf8');
        
        console.log(`\nResultado desencriptado: "${decryptedText}"`);
        
        return decryptedText;
      } else {
        console.log("No se detectó formato 'Salted__', probando método alternativo");
        
        // El formato puede ser diferente, intentemos otras opciones
        // Probar un enfoque más simple como podría hacerlo alguna versión de CryptoJS
        const md5Key = crypto.createHash('md5').update(key).digest();
        const iv = crypto.createHash('md5').update(md5Key).update(Buffer.from(salt, 'hex')).digest().slice(0, 16);
        
        try {
          const decipher = crypto.createDecipheriv('aes-256-cbc', md5Key, iv);
          let decrypted = decipher.update(encryptedData);
          decrypted = Buffer.concat([decrypted, decipher.final()]);
          const plaintext = decrypted.toString('utf8');
          
          console.log(`\nResultado alternativo: "${plaintext}"`);
          return plaintext;
        } catch (error) {
          console.log(`Error en método alternativo: ${error.message}`);
        }
      }
    } catch (error) {
      console.error(`Error general al desencriptar: ${error.message}`);
    }
    
    return null;
  } catch (error) {
    console.error(`Error: ${error.message}`);
    return null;
  }
}

/**
 * Derivar clave e IV usando método compatible con OpenSSL/CryptoJS
 */
function deriveKeyAndIv(password, salt) {
  const keySize = 32; // Tamaño de clave para AES-256
  const ivSize = 16;  // Tamaño del IV
  
  let derivedBytes = Buffer.alloc(0);
  
  // Convertir la contraseña a buffer si es string
  const passwordBuffer = typeof password === 'string' ? Buffer.from(password) : password;
  
  // OpenSSL/CryptoJS usa una técnica de derivación basada en MD5
  // con concatenación de hashes previos
  let preHashedData = Buffer.alloc(0);
  
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

// Ejecutar la desencriptación
const result = decryptToken(encryptedValue);
console.log("\n------------------------------------------");
console.log(`Resultado final: ${result}`);
console.log("------------------------------------------"); 