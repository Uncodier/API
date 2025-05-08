/**
 * Script para desencriptar directamente un valor usando una clave específica
 */
import crypto from 'crypto';

// Valor encriptado y clave proporcionados directamente
const encryptedValue = "fb5932583790254357fab69f35e84645:U2FsdGVkX19UsJWdON5EVzcTUgNEnoYClcTdvPuoQwVsWAbJIcqffSXxVqcEY9fY";
const encryptionKey = "538d4ce2cd4a42ce8bfac01a4760f99e73b25b7f50ed458ab7602c29b8f7cc64";

console.log(`Valor encriptado: ${encryptedValue}`);
console.log(`Clave de encriptación: ${encryptionKey.substring(0, 5)}...`);

// MÉTODO 1: Intentar formato IV:EncryptedContent
function tryStandardDecryption() {
  console.log("\n--- MÉTODO 1: Formato IV:EncryptedContent estándar ---");
  
  const parts = encryptedValue.split(':');
  if (parts.length !== 2) {
    console.log("❌ Formato inválido, no contiene ':' como separador");
    return;
  }
  
  const iv = Buffer.from(parts[0], 'hex');
  console.log(`IV (hex): ${parts[0]}`);
  console.log(`IV length: ${iv.length} bytes`);
  
  // El segundo elemento podría ser base64 o hex, intentar ambos
  try {
    // Primero intentar como base64
    const encryptedTextB64 = Buffer.from(parts[1], 'base64');
    console.log(`Texto encriptado (asumiendo base64): ${parts[1]}`);
    console.log(`Texto encriptado decodificado length: ${encryptedTextB64.length} bytes`);
    
    // Crear varias opciones de clave
    const keyOptions = [
      { name: 'sha256', key: crypto.createHash('sha256').update(String(encryptionKey)).digest() },
      { name: 'raw-32bytes', key: Buffer.from(encryptionKey).slice(0, 32) },
      { name: 'raw-full', key: Buffer.from(encryptionKey) }
    ];
    
    // Probar con diferentes algoritmos
    const algorithms = ['aes-256-cbc', 'aes-256-ctr', 'aes-256-gcm', 'aes-256-ecb'];
    
    for (const keyOpt of keyOptions) {
      console.log(`\nProbando con clave derivada: ${keyOpt.name}`);
      
      for (const algo of algorithms) {
        try {
          console.log(`Intentando con algoritmo: ${algo}`);
          
          // Algunos algoritmos no requieren IV
          let decipher;
          if (algo === 'aes-256-ecb') {
            decipher = crypto.createDecipheriv(algo, keyOpt.key, null);
          } else {
            decipher = crypto.createDecipheriv(algo, keyOpt.key, iv);
          }
          
          let decrypted = decipher.update(encryptedTextB64);
          decrypted = Buffer.concat([decrypted, decipher.final()]);
          const result = decrypted.toString('utf8');
          
          if (result && result.length > 0) {
            console.log(`✅ ÉXITO con ${algo} + ${keyOpt.name}:`);
            console.log(`Resultado: "${result}"`);
            
            // Verificar si es JSON
            try {
              const json = JSON.parse(result);
              console.log("Es JSON válido:");
              console.log(JSON.stringify(json, null, 2));
            } catch (e) {
              console.log("No es JSON válido, solo texto plano");
            }
          }
        } catch (error) {
          console.log(`❌ Error con ${algo}: ${error.message}`);
        }
      }
    }
    
    // También probar como hex
    try {
      const encryptedTextHex = Buffer.from(parts[1], 'hex');
      console.log(`\nTexto encriptado (asumiendo hex): ${parts[1].substring(0, 20)}...`);
      console.log(`Texto encriptado decodificado length: ${encryptedTextHex.length} bytes`);
      
      for (const keyOpt of keyOptions) {
        for (const algo of algorithms) {
          if (algo === 'aes-256-ecb') continue; // Skip para no repetir
          
          try {
            const decipher = crypto.createDecipheriv(algo, keyOpt.key, iv);
            let decrypted = decipher.update(encryptedTextHex);
            decrypted = Buffer.concat([decrypted, decipher.final()]);
            const result = decrypted.toString('utf8');
            
            if (result && result.length > 0) {
              console.log(`✅ ÉXITO con ${algo} (hex) + ${keyOpt.name}:`);
              console.log(`Resultado: "${result}"`);
            }
          } catch (error) {
            // Ignorar errores para hex
          }
        }
      }
    } catch (hexError) {
      console.log(`❌ Error al procesar como hex: ${hexError.message}`);
    }
  } catch (error) {
    console.log(`❌ Error general: ${error.message}`);
  }
}

// MÉTODO 2: Formato OpenSSL/CryptoJS
function tryCryptoJSDecryption() {
  console.log("\n--- MÉTODO 2: Formato OpenSSL/CryptoJS ---");
  
  // Extraer parte que podría contener el contenido cifrado en formato CryptoJS
  const encryptedBase64 = encryptedValue.includes(':') ? 
    encryptedValue.split(':')[1] : encryptedValue;
  
  try {
    // Decodificar base64
    const encryptedData = Buffer.from(encryptedBase64, 'base64');
    
    // Mostrar los primeros bytes como texto crudo y hex
    console.log(`Primeros bytes como texto: "${encryptedData.slice(0, 16).toString('utf8')}"`);
    console.log(`Primeros bytes como hex: ${encryptedData.slice(0, 16).toString('hex')}`);
    
    // Verificar formato "Salted__"
    if (encryptedData.slice(0, 8).toString() === 'Salted__') {
      console.log("✅ Formato OpenSSL/CryptoJS detectado: 'Salted__'");
      
      // Extraer salt (8 bytes después del header)
      const salt = encryptedData.slice(8, 16);
      console.log(`Salt extraído: ${salt.toString('hex')}`);
      
      // Extraer datos cifrados (después del salt)
      const ciphertext = encryptedData.slice(16);
      console.log(`Tamaño del ciphertext: ${ciphertext.length} bytes`);
      
      // Derivar clave e IV usando el algoritmo EVP_BytesToKey
      const derivedKeyAndIv = getKeyAndIvFromPassword(encryptionKey, salt);
      console.log(`Clave derivada: ${derivedKeyAndIv.key.toString('hex').substring(0, 16)}...`);
      console.log(`IV derivado: ${derivedKeyAndIv.iv.toString('hex')}`);
      
      // Intentar desencriptar con AES-256-CBC (el modo estándar de OpenSSL)
      try {
        const decipher = crypto.createDecipheriv('aes-256-cbc', derivedKeyAndIv.key, derivedKeyAndIv.iv);
        let decrypted = decipher.update(ciphertext);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        const result = decrypted.toString('utf8');
        
        if (result && result.length > 0) {
          console.log(`✅ ÉXITO con OpenSSL EVP_BytesToKey:`);
          console.log(`Resultado: "${result}"`);
          
          // Verificar si es JSON
          try {
            const json = JSON.parse(result);
            console.log("Es JSON válido:");
            console.log(JSON.stringify(json, null, 2));
          } catch (e) {
            console.log("No es JSON válido, solo texto plano");
          }
        }
      } catch (error) {
        console.log(`❌ Error al desencriptar con OpenSSL: ${error.message}`);
      }
    } else {
      console.log("❌ No se detectó formato OpenSSL/CryptoJS 'Salted__'");
    }
  } catch (error) {
    console.log(`❌ Error al procesar datos en base64: ${error.message}`);
  }
}

// Implementación de OpenSSL EVP_BytesToKey para derivar clave e IV
function getKeyAndIvFromPassword(password, salt) {
  // OpenSSL usa un proceso de derivación específico con MD5
  let keyAndIv = Buffer.alloc(0);
  let block;
  
  // La longitud que necesitamos es 32 bytes para la clave y 16 para el IV
  while (keyAndIv.length < 48) {
    let md5Hasher = crypto.createHash('md5');
    
    if (block) {
      md5Hasher.update(block);
    }
    
    md5Hasher.update(Buffer.from(password));
    
    if (salt) {
      md5Hasher.update(salt);
    }
    
    block = md5Hasher.digest();
    keyAndIv = Buffer.concat([keyAndIv, block]);
  }
  
  return {
    key: keyAndIv.slice(0, 32),  // AES-256 usa 32 bytes (256 bits)
    iv: keyAndIv.slice(32, 48)   // IV normalmente 16 bytes
  };
}

// MÉTODO 3: Analizamos la segunda parte directamente como contenido cifrado directamente
function tryDirectDecryption() {
  console.log("\n--- MÉTODO 3: Análisis directo ---");
  
  // Decodificar la segunda parte como base64
  const encryptedDataB64 = encryptedValue.split(':')[1];
  const encryptedBinary = Buffer.from(encryptedDataB64, 'base64');
  
  console.log(`Texto encriptado en base64: ${encryptedDataB64}`);
  console.log(`Longitud del binario decodificado: ${encryptedBinary.length} bytes`);
  
  // Probar con diferentes contraseñas como clave directamente
  const keyOptions = [
    encryptionKey,
    crypto.createHash('md5').update(encryptionKey).digest().toString('hex'),
    crypto.createHash('sha1').update(encryptionKey).digest().toString('hex'),
    crypto.createHash('sha256').update(encryptionKey).digest().toString('hex')
  ];
  
  // Generar todos los posibles IVs
  const ivOptions = [
    Buffer.from(encryptedValue.split(':')[0], 'hex'), // Usar primera parte como IV
    crypto.randomBytes(16)                           // Generar IV aleatorio para pruebas
  ];
  
  console.log("Probando descifrado directo con múltiples combinaciones...");
  
  for (const password of keyOptions) {
    // Crear clave AES
    const key = crypto.createHash('sha256').update(password).digest();
    
    for (const iv of ivOptions) {
      try {
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        let decrypted = decipher.update(encryptedBinary);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        const result = decrypted.toString('utf8');
        
        if (result && /^[\x20-\x7E\s]+$/.test(result)) {
          console.log(`✅ ÉXITO con AES-256-CBC:`);
          console.log(`Clave: ${password.substring(0, 10)}...`);
          console.log(`IV: ${iv.toString('hex').substring(0, 10)}...`);
          console.log(`Resultado: "${result}"`);
          
          // Verificar si es JSON
          try {
            const json = JSON.parse(result);
            console.log("Es JSON válido:");
            console.log(JSON.stringify(json, null, 2));
          } catch (e) {
            // Ignorar
          }
        }
      } catch (error) {
        // Ignorar errores ya que estamos probando muchas combinaciones
      }
    }
  }
}

// Ejecutar todos los métodos
console.log("=".repeat(60));
console.log("INICIANDO DESCIFRADO CON MÚLTIPLES MÉTODOS");
console.log("=".repeat(60));
tryStandardDecryption();
tryCryptoJSDecryption();
tryDirectDecryption();
console.log("=".repeat(60));
console.log("FIN INTENTO DE DESCIFRADO");
console.log("=".repeat(60)); 