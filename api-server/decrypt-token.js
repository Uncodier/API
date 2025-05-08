/**
 * Script para obtener y desencriptar manualmente el token de email
 * Usa la ENCRYPTION_KEY del archivo .env.local
 */

import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import fs from 'fs';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

// Configurar __dirname equivalente para ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Cargar variables de entorno
dotenv.config({ path: path.join(__dirname, '.env.local') });

// Constantes y configuración
const SITE_ID = 'f87bdc7f-0efe-4aa5-b499-49d85be4b154';
const TOKEN_TYPE = 'email';

// Función para obtener el cliente de Supabase
function getSupabaseClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  
  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error("Faltan variables de entorno para Supabase");
  }
  
  return createClient(supabaseUrl, supabaseServiceKey);
}

// Función para obtener el token de la base de datos
async function getTokenFromDB(siteId) {
  try {
    console.log(`Obteniendo token para sitio ${siteId}...`);
    const supabase = getSupabaseClient();
    
    // Obtener el token
    const { data, error } = await supabase
      .from('secure_tokens')
      .select('*')
      .eq('site_id', siteId)
      .eq('token_type', TOKEN_TYPE)
      .maybeSingle();
    
    if (error) {
      console.error('Error al obtener token:', error);
      return null;
    }
    
    if (!data) {
      console.log(`No se encontró token para el sitio ${siteId}`);
      return null;
    }
    
    console.log('Token encontrado en la base de datos:');
    console.log(JSON.stringify(data, null, 2));
    
    // Intentar con diferentes campos posibles
    if (data.encrypted_value) {
      console.log('Usando campo encrypted_value para desencriptar');
      return {
        encrypted: data.encrypted_value,
        field: 'encrypted_value'
      };
    }
    
    // Probar otros campos si encrypted_value no existe
    for (const field of ['value', 'token_value', 'token']) {
      if (data[field]) {
        console.log(`Usando campo ${field} para desencriptar`);
        return {
          encrypted: data[field],
          field
        };
      }
    }
    
    console.log('No se encontró ningún valor encriptado');
    return null;
  } catch (error) {
    console.error('Error al acceder a la base de datos:', error);
    return null;
  }
}

// Función para desencriptar token usando múltiples algoritmos para probar
async function decryptToken(encryptedValue) {
  try {
    const encryptionKey = process.env.ENCRYPTION_KEY;
    
    if (!encryptionKey) {
      throw new Error('La variable ENCRYPTION_KEY no está definida');
    }
    
    console.log(`Usando ENCRYPTION_KEY: "${encryptionKey.substring(0, 3)}..." (${encryptionKey.length} caracteres)`);
    console.log(`Valor completo encriptado: "${encryptedValue}"`);
    
    const results = [];
    
    // MÉTODO 1: Intentar formato IV:EncryptedContent estándar
    if (encryptedValue.includes(':')) {
      console.log('\n--- MÉTODO 1: Formato IV:EncryptedContent ---');
      
      const parts = encryptedValue.split(':');
      if (parts.length === 2) {
        const iv = Buffer.from(parts[0], 'hex');
        const encryptedText = Buffer.from(parts[1], 'hex');
        
        console.log(`IV: ${parts[0].substring(0, 10)}... (${parts[0].length} caracteres)`);
        console.log(`Contenido encriptado: ${parts[1].substring(0, 10)}... (${parts[1].length} caracteres)`);
        
        // Crear hashes de la clave para diferentes longitudes
        const keyHash256 = crypto.createHash('sha256').update(String(encryptionKey)).digest();
        const keyHash512 = crypto.createHash('sha512').update(String(encryptionKey)).digest().slice(0, 32);
        const rawKey32 = Buffer.from(encryptionKey).slice(0, 32);
        
        // Probar diferentes algoritmos de cifrado
        const algorithms = [
          { name: 'aes-256-cbc', key: keyHash256 },
          { name: 'aes-256-ctr', key: keyHash256 },
          { name: 'aes-256-ecb', key: keyHash256 },
          { name: 'aes-256-cbc', key: keyHash512 },
          { name: 'aes-256-ctr', key: keyHash512 },
          { name: 'aes-256-ecb', key: keyHash512 },
          { name: 'aes-256-cbc', key: rawKey32 },
          { name: 'aes-256-ctr', key: rawKey32 },
          { name: 'aes-256-ecb', key: rawKey32 }
        ];
        
        // Probar todos los algoritmos
        for (const algo of algorithms) {
          try {
            console.log(`Intentando desencriptar con ${algo.name}...`);
            
            // Algunos algoritmos no requieren IV
            let decipher;
            if (algo.name === 'aes-256-ecb') {
              decipher = crypto.createDecipheriv(algo.name, algo.key, null);
            } else {
              decipher = crypto.createDecipheriv(algo.name, algo.key, iv);
            }
            
            let decrypted = decipher.update(encryptedText);
            try {
              decrypted = Buffer.concat([decrypted, decipher.final()]);
              const result = decrypted.toString('utf-8');
              
              if (result && result.length > 0) {
                console.log(`✅ ÉXITO con ${algo.name}: "${result.substring(0, 30)}..." (${result.length} caracteres)`);
                
                try {
                  const json = JSON.parse(result);
                  console.log('  Parece ser JSON válido:');
                  console.log('  ', JSON.stringify(json, null, 2));
                  results.push({ method: 1, algorithm: algo.name, result, isJson: true, json });
                } catch (e) {
                  console.log('  No es JSON válido, asumiendo texto plano');
                  results.push({ method: 1, algorithm: algo.name, result, isJson: false });
                }
              }
            } catch (finalError) {
              console.log(`❌ Error en final() con ${algo.name}: ${finalError.message}`);
            }
          } catch (algoError) {
            console.log(`❌ Error con ${algo.name}: ${algoError.message}`);
          }
        }
      }
    }
    
    // MÉTODO 2: Intento con formato de crypto-js (prepended salt)
    console.log('\n--- MÉTODO 2: Formato CryptoJS con salt ---');
    try {
      // Crypto-js usa el formato "Salted__" + salt(8) + ciphertext
      // Intentar directamente si el valor es base64
      const encryptedTextBase64 = encryptedValue.includes(':') ? 
        encryptedValue.split(':')[1] : encryptedValue;
      
      // Probar con diferentes métodos de descifrado
      const cryptoJsMethods = [
        { name: 'AES con derivación de clave PBKDF2', fn: tryDecryptCryptoJsWithEvpKDF },
        { name: 'AES directo con clave', fn: tryDecryptDirectAES }
      ];
      
      for (const method of cryptoJsMethods) {
        try {
          console.log(`Intentando ${method.name}...`);
          const result = await method.fn(encryptedTextBase64, encryptionKey);
          
          if (result) {
            console.log(`✅ ÉXITO con ${method.name}: "${result.substring(0, 30)}..." (${result.length} caracteres)`);
            
            try {
              const json = JSON.parse(result);
              console.log('  Parece ser JSON válido:');
              console.log('  ', JSON.stringify(json, null, 2));
              results.push({ method: 2, algorithm: method.name, result, isJson: true, json });
            } catch (e) {
              console.log('  No es JSON válido, asumiendo texto plano');
              results.push({ method: 2, algorithm: method.name, result, isJson: false });
            }
          }
        } catch (error) {
          console.log(`❌ Error con ${method.name}: ${error.message}`);
        }
      }
    } catch (error) {
      console.log(`❌ Error en método CryptoJS: ${error.message}`);
    }
    
    // MÉTODO 3: Análisis directo del valor encriptado como Base64
    console.log('\n--- MÉTODO 3: Decodificación directa de Base64 ---');
    try {
      // Intentar decodificar como base64 directamente
      let base64Value = encryptedValue;
      if (encryptedValue.includes(':')) {
        base64Value = encryptedValue.split(':')[1];
        console.log(`Usando parte después de ':' como posible Base64: ${base64Value}`);
      }
      
      try {
        const decodedBuffer = Buffer.from(base64Value, 'base64');
        const decodedText = decodedBuffer.toString('utf-8');
        
        console.log(`Texto decodificado: "${decodedText.substring(0, 30)}..." (${decodedText.length} caracteres)`);
        
        // Verificar si parece texto legible o contiene caracteres de control
        const isPrintable = /^[\x20-\x7E\s]+$/.test(decodedText);
        if (isPrintable) {
          console.log('✅ La decodificación Base64 produjo texto legible');
          
          try {
            const json = JSON.parse(decodedText);
            console.log('  Parece ser JSON válido:');
            console.log('  ', JSON.stringify(json, null, 2));
            results.push({ method: 3, algorithm: 'base64', result: decodedText, isJson: true, json });
          } catch (e) {
            console.log('  No es JSON válido, asumiendo texto plano');
            results.push({ method: 3, algorithm: 'base64', result: decodedText, isJson: false });
          }
        } else {
          console.log('❌ La decodificación Base64 no produjo texto legible (podría ser datos binarios)');
          
          // Intentar descifrar con AES después de decodificar base64
          console.log('Intentando descifrar los datos binarios como posible datos AES...');
          
          // Extraer salt si existe el formato Salted__
          if (decodedBuffer.slice(0, 8).toString() === 'Salted__') {
            const salt = decodedBuffer.slice(8, 16);
            const actualEncrypted = decodedBuffer.slice(16);
            
            console.log(`Detectado formato OpenSSL/CryptoJS: Salt=${salt.toString('hex')}`);
            
            // Generar clave e IV usando salt y contraseña
            const keyAndIv = getKeyAndIvFromPassword(encryptionKey, salt);
            
            try {
              const decipher = crypto.createDecipheriv('aes-256-cbc', keyAndIv.key, keyAndIv.iv);
              let decrypted = decipher.update(actualEncrypted);
              decrypted = Buffer.concat([decrypted, decipher.final()]);
              const result = decrypted.toString('utf-8');
              
              console.log(`✅ ÉXITO con OpenSSL/CryptoJS: "${result.substring(0, 30)}..." (${result.length} caracteres)`);
              
              try {
                const json = JSON.parse(result);
                console.log('  Parece ser JSON válido:');
                console.log('  ', JSON.stringify(json, null, 2));
                results.push({ method: 3, algorithm: 'openssl-aes', result, isJson: true, json });
              } catch (e) {
                console.log('  No es JSON válido, asumiendo texto plano');
                results.push({ method: 3, algorithm: 'openssl-aes', result, isJson: false });
              }
            } catch (opensslError) {
              console.log(`❌ Error con descifrado OpenSSL: ${opensslError.message}`);
            }
          }
        }
      } catch (base64Error) {
        console.log(`❌ Error decodificando Base64: ${base64Error.message}`);
      }
    } catch (error) {
      console.log(`❌ Error en método Base64: ${error.message}`);
    }
    
    return results;
  } catch (error) {
    console.error('Error al desencriptar:', error);
    return [];
  }
}

// Funciones auxiliares para diferentes métodos de descifrado

// Descifrado específico para formato CryptoJS con derivación de clave EVP_BytesToKey
function tryDecryptCryptoJsWithEvpKDF(encryptedBase64, passphrase) {
  try {
    // Decodificar base64
    const encryptedData = Buffer.from(encryptedBase64, 'base64');
    
    // Verificar formato OpenSSL/CryptoJS
    if (encryptedData.slice(0, 8).toString() !== 'Salted__') {
      console.log('  No se detectó formato "Salted__" esperado');
      return null;
    }
    
    // Extraer salt
    const salt = encryptedData.slice(8, 16);
    console.log(`  Salt extraído: ${salt.toString('hex')}`);
    
    // Extraer datos cifrados
    const ciphertext = encryptedData.slice(16);
    
    // Generar clave e IV usando el algoritmo EVP_BytesToKey (el que usa CryptoJS)
    const keyAndIv = getKeyAndIvFromPassword(passphrase, salt);
    
    // Descifrar
    const decipher = crypto.createDecipheriv('aes-256-cbc', keyAndIv.key, keyAndIv.iv);
    let decrypted = decipher.update(ciphertext);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    
    return decrypted.toString('utf-8');
  } catch (error) {
    console.log(`  Error en descifrado CryptoJS: ${error.message}`);
    return null;
  }
}

// Implementación similar a OpenSSL EVP_BytesToKey para derivar clave e IV
function getKeyAndIvFromPassword(password, salt) {
  const iterations = 1;
  const keyLength = 32; // AES-256 requiere 32 bytes
  const ivLength = 16;  // CBC requiere 16 bytes
  
  // Convertir password a buffer si es string
  const passwordBuffer = Buffer.from(password);
  
  // Generar material de clave usando MD5 (como lo hace OpenSSL)
  const md5 = crypto.createHash('md5');
  let keyAndIv = Buffer.alloc(0);
  let block;
  
  for (let i = 0; i < (keyLength + ivLength) / 16; i++) {
    const md5 = crypto.createHash('md5');
    
    // Para el primer bloque, solo password y salt
    if (i > 0) {
      md5.update(block);
    }
    
    md5.update(passwordBuffer);
    
    if (salt) {
      md5.update(salt);
    }
    
    block = md5.digest();
    
    keyAndIv = Buffer.concat([keyAndIv, block]);
  }
  
  return {
    key: keyAndIv.slice(0, keyLength),
    iv: keyAndIv.slice(keyLength, keyLength + ivLength)
  };
}

// Descifrado directo AES para probar
function tryDecryptDirectAES(encryptedBase64, passphrase) {
  try {
    const encryptedBuffer = Buffer.from(encryptedBase64, 'base64');
    
    // Probar diferentes métodos y algoritmos
    const keyOptions = [
      crypto.createHash('sha256').update(passphrase).digest(),
      Buffer.from(passphrase).slice(0, 32)
    ];
    
    // En caso de que haya salt, intentar extraerlo
    let ivOptions = [
      // Sin salt/iv específico
      Buffer.alloc(16, 0),
      // Usar primeros 16 bytes como IV
      encryptedBuffer.slice(0, 16)
    ];
    
    // Si detectamos formato Salted__
    if (encryptedBuffer.slice(0, 8).toString() === 'Salted__') {
      const salt = encryptedBuffer.slice(8, 16);
      const derivedKeyAndIv = getKeyAndIvFromPassword(passphrase, salt);
      
      keyOptions.push(derivedKeyAndIv.key);
      ivOptions.push(derivedKeyAndIv.iv);
    }
    
    // Iterar por todas las combinaciones
    for (const key of keyOptions) {
      for (const iv of ivOptions) {
        try {
          const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
          // Si tiene padding, intentar removerlo
          decipher.setAutoPadding(true);
          
          // Para datos cifrados sin "Salted__", usar todo el buffer
          const dataToDecrypt = encryptedBuffer.slice(0, 8).toString() === 'Salted__' ?
            encryptedBuffer.slice(16) : encryptedBuffer;
            
          let decrypted = decipher.update(dataToDecrypt);
          decrypted = Buffer.concat([decrypted, decipher.final()]);
          const resultText = decrypted.toString('utf-8');
          
          // Verificar si parece texto válido
          if (resultText && /^[\x20-\x7E\s]+$/.test(resultText)) {
            return resultText;
          }
        } catch (e) {
          // Ignorar errores y continuar con el siguiente método
        }
      }
    }
    
    return null;
  } catch (error) {
    console.log(`  Error en descifrado directo AES: ${error.message}`);
    return null;
  }
}

// Ejecución principal
async function main() {
  try {
    // Obtener token de la base de datos
    const tokenData = await getTokenFromDB(SITE_ID);
    
    if (!tokenData) {
      console.log('No se encontró ningún token para desencriptar');
      return;
    }
    
    console.log('='.repeat(50));
    console.log(`Intentando desencriptar valor: ${tokenData.encrypted.substring(0, 20)}...`);
    console.log('='.repeat(50));
    
    // Desencriptar el token con múltiples intentos
    const results = await decryptToken(tokenData.encrypted);
    
    if (results.length > 0) {
      console.log('\n=== RESULTADOS OBTENIDOS ===');
      results.forEach((r, i) => {
        console.log(`\nResultado #${i+1} (${r.algorithm}):`);
        console.log(r.isJson ? JSON.stringify(r.json, null, 2) : r.result);
      });
      
      // Guardar resultados en un archivo
      fs.writeFileSync(
        'token-decryption-results.json', 
        JSON.stringify(results, null, 2)
      );
      console.log('\nResultados guardados en token-decryption-results.json');
    } else {
      console.log('\nNo se pudo desencriptar el token con ningún método');
    }
  } catch (error) {
    console.error('Error en la ejecución principal:', error);
  }
}

// Ejecutar
main().catch(console.error); 