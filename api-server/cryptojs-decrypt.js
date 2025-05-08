/**
 * Script para desencriptar tokens en formato CryptoJS
 * Basado en el código de encriptación proporcionado
 */
import crypto from 'crypto';

// Valor encriptado y clave para probar
const encryptedValue = "fb5932583790254357fab69f35e84645:U2FsdGVkX19UsJWdON5EVzcTUgNEnoYClcTdvPuoQwVsWAbJIcqffSXxVqcEY9fY";
const ENCRYPTION_KEY = 'Encryption-key'; // La clave usada en el código original

console.log(`Intentando desencriptar: ${encryptedValue}`);
console.log(`Usando clave base: ${ENCRYPTION_KEY}`);

/**
 * Función para desencriptar en formato CryptoJS
 * En este formato, se almacena como salt:encrypted
 * La clave usada es ENCRYPTION_KEY + salt
 */
function decryptCryptoJSFormat(encryptedValue, baseKey) {
  try {
    console.log("Separando salt y contenido encriptado...");
    
    // Separar salt y texto encriptado
    const [salt, encrypted] = encryptedValue.split(':');
    
    if (!salt || !encrypted) {
      throw new Error('Formato inválido, debe ser "salt:encrypted"');
    }
    
    console.log(`Salt: ${salt}`);
    console.log(`Encrypted: ${encrypted.substring(0, 20)}...`);
    
    // La clave de descifrado es la combinación de la clave base + salt
    const key = baseKey + salt;
    console.log(`Clave derivada: ${key.substring(0, 10)}...`);
    
    // Opción 1: Implementación directa de AES similar a CryptoJS
    console.log("\n=== Opción 1: Implementación usando Node.js crypto ===");
    try {
      // En CryptoJS, el encrypted incluye información sobre el IV
      // Intentemos decodificar primero en base64
      const encryptedBase64 = Buffer.from(encrypted, 'base64');
      
      // Extraer algunos datos para depuración
      if (encryptedBase64.length > 16) {
        console.log(`Datos encriptados (primeros 16 bytes hex): ${encryptedBase64.slice(0, 16).toString('hex')}`);
      }
      
      // Derivar clave para descifrado
      const keyHash = crypto.createHash('md5').update(key).digest();
      
      // OpenSSL/CryptoJS usa un formato donde los primeros 8 bytes son un indicador,
      // seguidos de 8 bytes de salt. Intentemos detectar ese formato
      const startsWithSalted = encryptedBase64.slice(0, 8).toString() === 'Salted__';
      if (startsWithSalted) {
        console.log("  Detectado formato 'Salted__'");
        
        // Extraer el salt del contenido encriptado
        const contentSalt = encryptedBase64.slice(8, 16);
        console.log(`  Salt interno: ${contentSalt.toString('hex')}`);
        
        // El contenido cifrado real comienza después
        const ciphertext = encryptedBase64.slice(16);
        console.log(`  Tamaño del ciphertext: ${ciphertext.length} bytes`);
        
        // Derivar clave e IV usando algoritmo OpenSSL EVP_BytesToKey
        const derivedKeyAndIv = getKeyAndIvFromPassword(key, contentSalt);
        
        // Intentar descifrar
        try {
          const decipher = crypto.createDecipheriv('aes-256-cbc', derivedKeyAndIv.key, derivedKeyAndIv.iv);
          let decrypted = decipher.update(ciphertext);
          decrypted = Buffer.concat([decrypted, decipher.final()]);
          const result = decrypted.toString('utf8');
          
          console.log("  ✅ Descifrado exitoso usando formato CryptoJS/OpenSSL:");
          console.log(`  Resultado: "${result}"`);
          
          // Verificar si es JSON
          try {
            const json = JSON.parse(result);
            console.log("  Es un objeto JSON válido:");
            console.log(JSON.stringify(json, null, 2));
          } catch (e) {
            console.log("  No es JSON válido, solo texto plano");
          }
        } catch (cryptoError) {
          console.log(`  ❌ Error al descifrar: ${cryptoError.message}`);
        }
      } else {
        console.log("  No se detectó formato 'Salted__', probando otros métodos...");
      }
    } catch (nodeError) {
      console.log(`  ❌ Error general en Node.js crypto: ${nodeError.message}`);
    }
    
    // Opción 2: Implementación basada en emulación directa de CryptoJS
    console.log("\n=== Opción 2: Emulación de algoritmo CryptoJS específico ===");
    try {
      // 1. Decodificar base64
      const cipherParams = parseCipherTextFromBase64(encrypted);
      if (!cipherParams) {
        console.log("  ❌ No se pudo parsear el formato CryptoJS");
        return null;
      }
      
      console.log(`  Formato CryptoJS parseado correctamente`);
      console.log(`  IV detectado: ${cipherParams.iv.toString('hex')}`);
      console.log(`  Salt detectado: ${cipherParams.salt ? cipherParams.salt.toString('hex') : 'No encontrado'}`);
      
      // 2. Derivar clave a partir del salt (si existe) o usar la clave directamente
      let derivedKey;
      if (cipherParams.salt) {
        // El caso normal de CryptoJS donde el salt está en el cipherParams
        console.log(`  Derivando clave usando salt interno...`);
        const keyAndIv = getKeyAndIvFromPassword(key, cipherParams.salt);
        derivedKey = keyAndIv.key;
      } else {
        // Intentar con el salt del encryptedValue
        console.log(`  Derivando clave usando salt externo...`);
        const keyAndIv = getKeyAndIvFromPassword(key, Buffer.from(salt, 'hex'));
        derivedKey = keyAndIv.key;
      }
      
      // 3. Descifrar
      try {
        const decipher = crypto.createDecipheriv('aes-256-cbc', derivedKey, cipherParams.iv);
        let decrypted = decipher.update(cipherParams.ciphertext);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        const result = decrypted.toString('utf8');
        
        console.log("  ✅ Descifrado exitoso usando emulación CryptoJS:");
        console.log(`  Resultado: "${result}"`);
        
        // Verificar si es JSON
        try {
          const json = JSON.parse(result);
          console.log("  Es un objeto JSON válido:");
          console.log(JSON.stringify(json, null, 2));
        } catch (e) {
          console.log("  No es JSON válido, solo texto plano");
        }
      } catch (cryptoError) {
        console.log(`  ❌ Error al descifrar: ${cryptoError.message}`);
      }
    } catch (emulateError) {
      console.log(`  ❌ Error en emulación CryptoJS: ${emulateError.message}`);
    }
    
    // Opción 3: Probar diferentes combinaciones de salt, claves y formatos
    console.log("\n=== Opción 3: Búsqueda exhaustiva ===");
    
    const saltOptions = [
      Buffer.from(salt, 'hex'),          // Salt como hex
      Buffer.from(salt),                 // Salt como utf-8
      Buffer.from(salt, 'base64')        // Salt como base64 (menos probable)
    ];
    
    const keyDerivations = [
      baseKey + salt,                    // Como en el código original
      baseKey,                           // Solo clave base
      crypto.createHash('md5').update(baseKey + salt).digest() // Hash MD5 de la combinación
    ];
    
    let successFound = false;
    
    for (const saltOption of saltOptions) {
      for (const keyDeriv of keyDerivations) {
        try {
          console.log(`  Probando combinación salt/clave...`);
          
          // Generar clave e IV según el formato de OpenSSL/CryptoJS
          const keyAndIv = getKeyAndIvFromPassword(keyDeriv, saltOption);
          
          // Decodificar el texto cifrado
          const encryptedData = Buffer.from(encrypted, 'base64');
          
          // Verificar si tiene formato OpenSSL (Salted__)
          const ciphertext = encryptedData.slice(0, 8).toString() === 'Salted__' ? 
                            encryptedData.slice(16) : encryptedData;
          
          // Intentar descifrar
          const decipher = crypto.createDecipheriv('aes-256-cbc', keyAndIv.key, keyAndIv.iv);
          let decrypted = decipher.update(ciphertext);
          decrypted = Buffer.concat([decrypted, decipher.final()]);
          const result = decrypted.toString('utf8');
          
          // Verificar si el resultado parece válido (caracteres imprimibles)
          if (result && /^[\x20-\x7E\s]+$/.test(result)) {
            console.log("  ✅ Descifrado exitoso por búsqueda exhaustiva:");
            console.log(`  Resultado: "${result}"`);
            
            // Verificar si es JSON
            try {
              const json = JSON.parse(result);
              console.log("  Es un objeto JSON válido:");
              console.log(JSON.stringify(json, null, 2));
            } catch (e) {
              console.log("  No es JSON válido, solo texto plano");
            }
            
            successFound = true;
            break;
          }
        } catch (error) {
          // Ignorar errores, estamos probando muchas combinaciones
        }
      }
      
      if (successFound) break;
    }
    
    if (!successFound) {
      console.log("  ❌ No se encontró una combinación exitosa");
    }
    
    return null;
  } catch (error) {
    console.error(`Error general al desencriptar: ${error.message}`);
    return null;
  }
}

// Función para derivar clave e IV desde una contraseña (compatible con OpenSSL/CryptoJS)
function getKeyAndIvFromPassword(password, salt) {
  const keySize = 32; // AES-256 requiere 32 bytes
  const ivSize = 16;  // CBC requiere 16 bytes
  const iterations = 1;
  
  let keyAndIv = Buffer.alloc(0);
  
  // Convertir la contraseña a Buffer si es string
  const passwordBuffer = typeof password === 'string' ? Buffer.from(password) : password;
  
  // Implementar algoritmo OpenSSL EVP_BytesToKey
  for (let i = 0; keyAndIv.length < keySize + ivSize; i++) {
    let md5 = crypto.createHash('md5');
    
    if (i > 0) {
      md5.update(keyAndIv.slice(-16)); // Usar los últimos 16 bytes (MD5 digest size)
    }
    
    md5.update(passwordBuffer);
    
    if (salt) {
      md5.update(salt);
    }
    
    keyAndIv = Buffer.concat([keyAndIv, md5.digest()]);
  }
  
  return {
    key: keyAndIv.slice(0, keySize),
    iv: keyAndIv.slice(keySize, keySize + ivSize)
  };
}

// Función para intentar parsear el formato CryptoJS desde base64
function parseCipherTextFromBase64(base64Str) {
  try {
    // Decodificar de base64
    const rawData = Buffer.from(base64Str, 'base64');
    
    // Verificar formato 'Salted__'
    if (rawData.slice(0, 8).toString() === 'Salted__') {
      // Formato estándar OpenSSL/CryptoJS
      const salt = rawData.slice(8, 16);
      // CryptoJS necesita un IV, generalmente se deriva también de la contraseña y salt
      const iv = rawData.slice(16, 32); // Este podría no ser correcto, depende de la implementación
      const ciphertext = rawData.slice(32);
      
      return { salt, iv, ciphertext };
    } else {
      // Podría ser un formato personalizado o sin salt
      // Intentemos dividirlo - asumiendo que el IV está en los primeros 16 bytes
      const iv = rawData.slice(0, 16);
      const ciphertext = rawData.slice(16);
      
      return { iv, ciphertext };
    }
  } catch (e) {
    console.log(`  Error al parsear formato CryptoJS: ${e.message}`);
    return null;
  }
}

// Ejecutar el intento de desencriptación
decryptCryptoJSFormat(encryptedValue, ENCRYPTION_KEY); 