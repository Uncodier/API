import * as crypto from 'crypto';

/**
 * Desencripta un token usando Node.js crypto (AES-256-CBC)
 * Soporta dos formatos:
 * - Nuevo formato: iv:encryptedContent (hex) - usado por /api/secure-tokens/encrypt
 * - Formato antiguo: salt:encrypted (base64) - usado por CryptoJS (para compatibilidad)
 * 
 * Este método detecta automáticamente el formato y desencripta apropiadamente.
 */
export function decryptToken(encryptedValue: string): string | null {
  try {
    const encryptionKey = process.env.ENCRYPTION_KEY;
    
    if (!encryptionKey) {
      console.error('[TokenDecryption] Missing ENCRYPTION_KEY environment variable');
      return null;
    }
    
    // Extract the parts (format: part1:part2)
    const parts = encryptedValue.split(':');
    if (parts.length !== 2) {
      console.error('[TokenDecryption] Invalid token format, expected part1:part2');
      return null;
    }
    
    const part1 = parts[0];
    const part2 = parts[1];
    
    // Detect format: new format uses hex (iv:encryptedContent), old format uses base64 (salt:encrypted)
    // New format: IV is 32 hex chars (16 bytes), encrypted is hex
    // Old format: salt is shorter, encrypted is base64 (CryptoJS format)
    
    const isHexFormat = /^[0-9a-fA-F]+$/.test(part1) && /^[0-9a-fA-F]+$/.test(part2) && part1.length === 32;
    const isBase64Format = !isHexFormat && /^[A-Za-z0-9+/=]+$/.test(part1) && /^[A-Za-z0-9+/=]+$/.test(part2);
    
    if (isHexFormat) {
      // New format: Node.js crypto (iv:encryptedContent in hex)
      console.log('[TokenDecryption] Detected new format (hex)');
      return decryptNodeCryptoFormat(part1, part2, encryptionKey);
    } else if (isBase64Format) {
      // Old format: CryptoJS (salt:encrypted in base64)
      console.log('[TokenDecryption] Detected old format (base64), attempting CryptoJS decryption');
      return decryptCryptoJSFormat(part1, part2, encryptionKey);
    } else {
      console.error('[TokenDecryption] Unknown token format');
      return null;
    }
  } catch (error) {
    console.error('[TokenDecryption] Error decrypting token:', error instanceof Error ? error.message : 'Unknown error');
    if (error instanceof Error) {
      console.error('[TokenDecryption] Error details:', {
        name: error.name,
        message: error.message,
        stack: error.stack?.substring(0, 200)
      });
    }
    return null;
  }
}

/**
 * Desencripta usando el formato nuevo (Node.js crypto)
 * Formato: iv:encryptedContent (hex)
 */
function decryptNodeCryptoFormat(ivHex: string, encryptedHex: string, encryptionKey: string): string | null {
  try {
    // Encrypted text should be multiple of 32 hex chars (16 bytes blocks for AES-256-CBC)
    if (encryptedHex.length % 32 !== 0) {
      console.error(`[TokenDecryption] Invalid encrypted text length: ${encryptedHex.length} (must be multiple of 32 hex chars)`);
      return null;
    }
    
    const iv = Buffer.from(ivHex, 'hex');
    const encryptedText = Buffer.from(encryptedHex, 'hex');
    
    // Create key from the encryption key using SHA-256
    const key = crypto.createHash('sha256').update(String(encryptionKey)).digest();
    
    // Create decipher
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    
    // Decrypt
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    
    return decrypted.toString('utf8');
  } catch (error) {
    console.error('[TokenDecryption] Error in Node.js crypto format:', error instanceof Error ? error.message : 'Unknown error');
    return null;
  }
}

/**
 * Desencripta usando el formato antiguo (CryptoJS)
 * Formato: salt:encrypted (base64)
 * 
 * NOTA: Este formato es para compatibilidad con tokens antiguos.
 * Los nuevos tokens deben usar el formato Node.js crypto.
 */
function decryptCryptoJSFormat(salt: string, encrypted: string, encryptionKey: string): string | null {
  try {
    // Dynamic import to avoid requiring crypto-js if not needed
    const CryptoJS = require('crypto-js');
    
    console.log('[TokenDecryption] CryptoJS decrypt attempt:', {
      saltLength: salt.length,
      encryptedLength: encrypted.length,
      hasEncryptionKey: !!encryptionKey,
      encryptionKeyLength: encryptionKey?.length || 0,
      saltPreview: salt.substring(0, 10) + '...',
      encryptedPreview: encrypted.substring(0, 10) + '...'
    });
    
    // Method 1: encryptionKey + salt (standard CryptoJS format) - matches original behavior
    try {
      const combinedKey = encryptionKey + salt;
      const decrypted = CryptoJS.AES.decrypt(encrypted, combinedKey);
      const decryptedText = decrypted.toString(CryptoJS.enc.Utf8);
      
      console.log('[TokenDecryption] Method 1 (ENCRYPTION_KEY) result length:', decryptedText.length);
      
      if (decryptedText && decryptedText.length > 0) {
        console.log('[TokenDecryption] ✅ Successfully decrypted using ENCRYPTION_KEY + salt');
        return decryptedText;
      } else {
        console.log('[TokenDecryption] Method 1 failed: empty result');
      }
    } catch (error) {
      console.log('[TokenDecryption] Method 1 failed with error:', error instanceof Error ? error.message : 'Unknown');
    }
    
    // Method 2: Try with LEGACY_ENCRYPTION_KEY (replaces hardcoded 'Encryption-key')
    // This matches the original fallback behavior but uses environment variable instead of hardcode
    const legacyKey = process.env.LEGACY_ENCRYPTION_KEY;
    console.log('[TokenDecryption] Method 2: LEGACY_ENCRYPTION_KEY configured?', !!legacyKey);
    if (legacyKey) {
      try {
        const legacyCombinedKey = legacyKey + salt;
        const legacyDecrypted = CryptoJS.AES.decrypt(encrypted, legacyCombinedKey);
        const legacyDecryptedText = legacyDecrypted.toString(CryptoJS.enc.Utf8);
        
        console.log('[TokenDecryption] Method 2 (LEGACY_ENCRYPTION_KEY) result length:', legacyDecryptedText.length);
        
        if (legacyDecryptedText && legacyDecryptedText.length > 0) {
          console.log('[TokenDecryption] ✅ Successfully decrypted using LEGACY_ENCRYPTION_KEY (replaces hardcoded fallback)');
          return legacyDecryptedText;
        } else {
          console.log('[TokenDecryption] Method 2 failed: empty result');
        }
      } catch (error) {
        console.log('[TokenDecryption] Method 2 failed with error:', error instanceof Error ? error.message : 'Unknown');
      }
    } else {
      console.log('[TokenDecryption] Method 2 skipped: LEGACY_ENCRYPTION_KEY not set');
    }
    
    // Method 3: Try with ALT_ENCRYPTION_KEY (matches original behavior, but without NODE_ENV restriction)
    const altKey = process.env.ALT_ENCRYPTION_KEY;
    console.log('[TokenDecryption] Method 3: ALT_ENCRYPTION_KEY configured?', !!altKey);
    if (altKey) {
      try {
        const altCombinedKey = altKey + salt;
        const altDecrypted = CryptoJS.AES.decrypt(encrypted, altCombinedKey);
        const altDecryptedText = altDecrypted.toString(CryptoJS.enc.Utf8);
        
        console.log('[TokenDecryption] Method 3 (ALT_ENCRYPTION_KEY) result length:', altDecryptedText.length);
        
        if (altDecryptedText && altDecryptedText.length > 0) {
          console.log('[TokenDecryption] ✅ Successfully decrypted using ALT_ENCRYPTION_KEY');
          return altDecryptedText;
        } else {
          console.log('[TokenDecryption] Method 3 failed: empty result');
        }
      } catch (error) {
        console.log('[TokenDecryption] Method 3 failed with error:', error instanceof Error ? error.message : 'Unknown');
      }
    } else {
      console.log('[TokenDecryption] Method 3 skipped: ALT_ENCRYPTION_KEY not set');
    }
    
    // Method 5: Maybe the "salt" is actually an IV and this is Node.js crypto format in disguise?
    // If salt looks like hex (32 chars) and encrypted also looks like hex, try Node.js crypto
    if (/^[0-9a-fA-F]+$/.test(salt) && salt.length === 32 && /^[0-9a-fA-F]+$/.test(encrypted)) {
      try {
        console.log('[TokenDecryption] Both parts look like hex, trying Node.js crypto format...');
        return decryptNodeCryptoFormat(salt, encrypted, encryptionKey);
      } catch (error) {
        console.log('[TokenDecryption] Method 5 (hex interpretation) failed');
      }
    }
    
    console.error('[TokenDecryption] All CryptoJS decryption attempts failed');
    console.error('[TokenDecryption] This suggests the token was encrypted with a different key than ENCRYPTION_KEY');
    console.error('[TokenDecryption] Solution: Set LEGACY_ENCRYPTION_KEY in .env.local with the original encryption key');
    return null;
  } catch (error) {
    console.error('[TokenDecryption] Error in CryptoJS format:', error instanceof Error ? error.message : 'Unknown error');
    return null;
  }
}

