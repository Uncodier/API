import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import * as crypto from 'crypto';

// Error codes
const ERROR_CODES = {
  INVALID_REQUEST: 'INVALID_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  NOT_FOUND: 'NOT_FOUND',
  DATABASE_ERROR: 'DATABASE_ERROR',
  DECRYPTION_ERROR: 'DECRYPTION_ERROR',
  SYSTEM_ERROR: 'SYSTEM_ERROR'
};

// Get supabase client
function getSupabaseClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  
  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error("Missing Supabase environment variables");
  }
  
  return createClient(supabaseUrl, supabaseServiceKey);
}

// Token decryption utility - matching the implementation in the email agent
function decryptToken(encryptedValue: string): string {
  try {
    const encryptionKey = process.env.ENCRYPTION_KEY;
    
    if (!encryptionKey) {
      throw new Error("Missing ENCRYPTION_KEY environment variable");
    }
    
    // Extract the iv and encrypted content (assuming format: iv:encryptedContent)
    const parts = encryptedValue.split(':');
    if (parts.length !== 2) {
      throw new Error("Invalid encrypted token format");
    }
    
    const iv = Buffer.from(parts[0], 'hex');
    const encryptedText = Buffer.from(parts[1], 'hex');
    
    // Create key from the encryption key
    // Use SHA-256 to ensure key is the right length for AES-256
    const key = crypto.createHash('sha256').update(String(encryptionKey)).digest();
    
    // Create decipher
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    
    // Decrypt
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    
    return decrypted.toString();
  } catch (error) {
    console.error("Error decrypting token:", error);
    throw new Error(`Failed to decrypt token: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

// Schema validation function
function validateRequest(body: any) {
  if (!body.site_id) {
    return { isValid: false, error: "site_id is required" };
  }
  
  if (!body.token_type) {
    return { isValid: false, error: "token_type is required" };
  }
  
  return { isValid: true };
}

export async function POST(request: NextRequest) {
  console.log(`[DECRYPT_API] Iniciando petición POST...`);
  try {
    // Get request body
    const requestData = await request.json();
    
    // Log request (without sensitive data)
    console.log(`[DECRYPT_API] Procesando solicitud para sitio: ${requestData.site_id}`);
    
    // Validate request data
    const validation = validateRequest(requestData);
    if (!validation.isValid) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: ERROR_CODES.INVALID_REQUEST,
            message: validation.error
          }
        },
        { status: 400 }
      );
    }
    
    const { site_id, token_type, identifier } = requestData;
    
    try {
      const supabase = getSupabaseClient();
      
      console.log(`[DECRYPT_API] Buscando token en la tabla secure_tokens...`);
      
      // Build query
      let query = supabase
        .from('secure_tokens')
        .select('*')
        .eq('site_id', site_id)
        .eq('token_type', token_type);
      
      // Add identifier filter if provided
      if (identifier) {
        query = query.eq('identifier', identifier);
      }
      
      // Execute query
      const { data, error } = await query.maybeSingle();
      
      if (error) {
        console.error(`[DECRYPT_API] Error al consultar token:`, error);
        return NextResponse.json(
          {
            success: false,
            error: {
              code: ERROR_CODES.DATABASE_ERROR,
              message: `Error retrieving token: ${error.message}`
            }
          },
          { status: 500 }
        );
      }
      
      if (!data) {
        console.log(`[DECRYPT_API] No se encontró token para el sitio: ${site_id} y tipo: ${token_type}`);
        return NextResponse.json(
          {
            success: false,
            error: {
              code: ERROR_CODES.NOT_FOUND,
              message: `Token not found for site ${site_id} and type ${token_type}`
            }
          },
          { status: 404 }
        );
      }
      
      console.log(`[DECRYPT_API] Token encontrado, procesando...`);
      
      // Determine which field to use
      let encryptedValue;
      if (data.encrypted_value) {
        encryptedValue = data.encrypted_value;
      } else if (data.value && typeof data.value === 'string' && data.value.includes(':')) {
        encryptedValue = data.value;
      } else if (data.token_value && typeof data.token_value === 'string' && data.token_value.includes(':')) {
        encryptedValue = data.token_value;
      } else {
        console.log(`[DECRYPT_API] El token no está cifrado o tiene un formato inesperado`);
        
        // If it's already an object, parse it
        if (typeof data.value === 'object') {
          return NextResponse.json({
            success: true,
            data: {
              tokenValue: data.value,
              decrypted: false,
              message: "Token value is already an object, no decryption necessary"
            }
          });
        }
        
        // Return the raw value
        return NextResponse.json({
          success: true,
          data: {
            tokenValue: data.value || data.token_value,
            decrypted: false,
            message: "Token doesn't appear to be encrypted"
          }
        });
      }
      
      // Attempt decryption
      try {
        const decryptedValue = decryptToken(encryptedValue);
        
        // Update last_used timestamp if the field exists
        if (data.hasOwnProperty('last_used')) {
          await supabase
            .from('secure_tokens')
            .update({ last_used: new Date().toISOString() })
            .eq('id', data.id);
        }
        
        try {
          // Try to parse the decrypted value as JSON
          const parsedValue = JSON.parse(decryptedValue);
          return NextResponse.json({
            success: true,
            data: {
              tokenValue: parsedValue,
              decrypted: true,
              raw: decryptedValue
            }
          });
        } catch (jsonError) {
          // Not JSON, return as string
          return NextResponse.json({
            success: true,
            data: {
              tokenValue: decryptedValue,
              decrypted: true
            }
          });
        }
      } catch (decryptError: any) {
        console.error(`[DECRYPT_API] Error al descifrar token:`, decryptError);
        return NextResponse.json(
          {
            success: false,
            error: {
              code: ERROR_CODES.DECRYPTION_ERROR,
              message: decryptError.message,
              encryptedValue: encryptedValue // Include for debugging
            }
          },
          { status: 500 }
        );
      }
    } catch (dbError: any) {
      console.error(`[DECRYPT_API] Error en operación de base de datos:`, dbError);
      return NextResponse.json(
        {
          success: false,
          error: {
            code: ERROR_CODES.DATABASE_ERROR,
            message: dbError.message
          }
        },
        { status: 500 }
      );
    }
  } catch (error: any) {
    console.error(`[DECRYPT_API] Error procesando solicitud:`, error);
    return NextResponse.json(
      {
        success: false,
        error: {
          code: ERROR_CODES.SYSTEM_ERROR,
          message: error.message
        }
      },
      { status: 500 }
    );
  }
}

// For testing and documentation
export async function GET() {
  return NextResponse.json({
    success: true,
    message: "Token decryption service. Send a POST request with site_id and token_type to decrypt a token."
  });
} 