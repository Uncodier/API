import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { decryptToken } from '@/lib/utils/token-decryption';

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

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    
    // Validar parámetros
    if (!id) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: ERROR_CODES.INVALID_REQUEST,
            message: "Missing token id in URL"
          }
        },
        { status: 400 }
      );
    }
    
    // Obtener request body
    const requestData = await request.json();
    const { site_id } = requestData;
    
    if (!site_id) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: ERROR_CODES.INVALID_REQUEST,
            message: "site_id is required"
          }
        },
        { status: 400 }
      );
    }
    
    console.log(`[DECRYPT_API_BY_ID] Procesando solicitud para token ${id} y sitio: ${site_id}`);
    
    // Validar autorización (Service Key o API Key del sitio)
    const apiKeyDataStr = request.headers.get('x-api-key-data');
    if (!apiKeyDataStr) {
      // Debería ser capturado por el middleware, pero por si acaso
      return NextResponse.json(
        {
          success: false,
          error: {
            code: ERROR_CODES.UNAUTHORIZED,
            message: "API Key required"
          }
        },
        { status: 401 }
      );
    }
    
    const keyData = JSON.parse(apiKeyDataStr);
    
    // Verificar si es Service Key o si la API key pertenece al mismo site_id
    if (!keyData.isService && keyData.site_id !== site_id) {
      console.error(`[DECRYPT_API_BY_ID] Acceso denegado: La API key no pertenece al site_id solicitado.`);
      return NextResponse.json(
        {
          success: false,
          error: {
            code: ERROR_CODES.UNAUTHORIZED,
            message: "API key does not have access to this site"
          }
        },
        { status: 403 }
      );
    }
    
    // Buscar y desencriptar el token
    try {
      const supabase = getSupabaseClient();
      
      console.log(`[DECRYPT_API_BY_ID] Buscando token en la tabla secure_tokens...`);
      
      const { data, error } = await supabase
        .from('secure_tokens')
        .select('*')
        .eq('id', id)
        .eq('site_id', site_id)
        .maybeSingle();
      
      if (error) {
        console.error(`[DECRYPT_API_BY_ID] Error al consultar token:`, error);
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
        console.log(`[DECRYPT_API_BY_ID] No se encontró token para el ID: ${id} y sitio: ${site_id}`);
        return NextResponse.json(
          {
            success: false,
            error: {
              code: ERROR_CODES.NOT_FOUND,
              message: `Token not found`
            }
          },
          { status: 404 }
        );
      }
      
      console.log(`[DECRYPT_API_BY_ID] Token encontrado, procesando...`);
      
      // Determine which field to use
      let encryptedValue;
      if (data.encrypted_value) {
        encryptedValue = data.encrypted_value;
      } else if (data.value && typeof data.value === 'string' && data.value.includes(':')) {
        encryptedValue = data.value;
      } else if (data.token_value && typeof data.token_value === 'string' && data.token_value.includes(':')) {
        encryptedValue = data.token_value;
      } else {
        console.log(`[DECRYPT_API_BY_ID] El token no está cifrado o tiene un formato inesperado`);
        
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
      
      // Attempt decryption using shared utility
      const decryptedValue = decryptToken(encryptedValue);
      
      if (!decryptedValue) {
        console.error(`[DECRYPT_API_BY_ID] Failed to decrypt token`);
        return NextResponse.json(
          {
            success: false,
            error: {
              code: ERROR_CODES.DECRYPTION_ERROR,
              message: "Failed to decrypt token. The token may be in an unsupported format or encrypted with a different key.",
              encryptedValue: encryptedValue.substring(0, 50) + '...' // Include partial for debugging
            }
          },
          { status: 500 }
        );
      }
      
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
    } catch (dbError: any) {
      console.error(`[DECRYPT_API_BY_ID] Error en operación de base de datos:`, dbError);
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
    console.error(`[DECRYPT_API_BY_ID] Error procesando solicitud:`, error);
    return NextResponse.json(
      {
        success: false,
        error: {
          code: ERROR_CODES.SYSTEM_ERROR,
          message: error.message || 'Internal Server Error'
        }
      },
      { status: 500 }
    );
  }
}
