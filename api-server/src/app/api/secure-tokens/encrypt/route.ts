import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import * as crypto from 'crypto';
import { z } from 'zod';

// Validation schema
const EncryptTokenSchema = z.object({
  value: z.string().min(1, "Token value is required"),
  site_id: z.string().min(1, "Site ID is required"),
  token_type: z.string().min(1, "Token type is required"),
  identifier: z.string().optional(),
  store_in_db: z.boolean().default(false).optional(),
});

// Error codes
const ERROR_CODES = {
  INVALID_REQUEST: 'INVALID_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  DATABASE_ERROR: 'DATABASE_ERROR',
  ENCRYPTION_ERROR: 'ENCRYPTION_ERROR',
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

// Token encryption utility
function encryptToken(value: string): string {
  try {
    const encryptionKey = process.env.ENCRYPTION_KEY;
    
    if (!encryptionKey) {
      throw new Error("Missing ENCRYPTION_KEY environment variable");
    }
    
    // Generate a random IV
    const iv = crypto.randomBytes(16);
    
    // Create key from the encryption key
    // Use SHA-256 to ensure key is the right length for AES-256
    const key = crypto.createHash('sha256').update(String(encryptionKey)).digest();
    
    // Create cipher
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    
    // Encrypt
    let encrypted = cipher.update(Buffer.from(value, 'utf8'));
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    
    // Format as iv:encryptedContent in hex
    return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
  } catch (error) {
    console.error("Error encrypting token:", error);
    throw new Error(`Failed to encrypt token: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function POST(request: NextRequest) {
  console.log(`[ENCRYPT_API] Iniciando petición POST...`);
  try {
    // Get request body
    const requestData = await request.json();
    
    // Log request (without sensitive data)
    console.log(`[ENCRYPT_API] Procesando solicitud para sitio: ${requestData.site_id}`);
    
    // Validate request data
    const validationResult = EncryptTokenSchema.safeParse(requestData);
    
    if (!validationResult.success) {
      console.error("[ENCRYPT_API] Error de validación:", validationResult.error);
      return NextResponse.json(
        {
          success: false,
          error: {
            code: ERROR_CODES.INVALID_REQUEST,
            message: "Parámetros de solicitud inválidos",
            details: validationResult.error.format(),
          },
        },
        { status: 400 }
      );
    }
    
    const { value, site_id, token_type, identifier, store_in_db } = validationResult.data;
    
    try {
      // Encrypt the token
      const encryptedValue = encryptToken(value);
      console.log(`[ENCRYPT_API] Token encriptado correctamente`);
      
      // Store in database if requested
      if (store_in_db) {
        console.log(`[ENCRYPT_API] Almacenando token en base de datos...`);
        
        try {
          const supabase = getSupabaseClient();
          
          // Check if token already exists
          const { data: existingToken, error: checkError } = await supabase
            .from('secure_tokens')
            .select('id')
            .eq('site_id', site_id)
            .eq('token_type', token_type)
            .maybeSingle();
            
          if (checkError) {
            console.error(`[ENCRYPT_API] Error al verificar token existente:`, checkError);
            throw new Error(`Database query error: ${checkError.message}`);
          }
          
          // Prepare token data
          const tokenData: {
            site_id: string;
            token_type: string;
            encrypted_value: string;
            created_at: string;
            last_used: string;
            identifier?: string;
          } = {
            site_id,
            token_type,
            encrypted_value: encryptedValue,
            created_at: new Date().toISOString(),
            last_used: new Date().toISOString()
          };
          
          // Add identifier if provided
          if (identifier) {
            tokenData.identifier = identifier;
          }
          
          // Insert or update token
          let result;
          if (existingToken) {
            console.log(`[ENCRYPT_API] Actualizando token existente con ID: ${existingToken.id}`);
            result = await supabase
              .from('secure_tokens')
              .update(tokenData)
              .eq('id', existingToken.id);
          } else {
            console.log(`[ENCRYPT_API] Creando nuevo token`);
            result = await supabase
              .from('secure_tokens')
              .insert(tokenData);
          }
          
          if (result.error) {
            console.error(`[ENCRYPT_API] Error al guardar token:`, result.error);
            throw new Error(`Database error: ${result.error.message}`);
          }
          
          console.log(`[ENCRYPT_API] Token guardado correctamente en base de datos`);
        } catch (dbError: any) {
          console.error(`[ENCRYPT_API] Error en operación de base de datos:`, dbError);
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
      }
      
      // Return the encrypted value
      return NextResponse.json({
        success: true,
        data: {
          encrypted_value: encryptedValue,
          stored_in_db: store_in_db
        }
      });
      
    } catch (encryptError: any) {
      console.error(`[ENCRYPT_API] Error al encriptar token:`, encryptError);
      return NextResponse.json(
        {
          success: false,
          error: {
            code: ERROR_CODES.ENCRYPTION_ERROR,
            message: encryptError.message
          }
        },
        { status: 500 }
      );
    }
    
  } catch (error: any) {
    console.error(`[ENCRYPT_API] Error procesando solicitud:`, error);
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
    message: "Token encryption service. Send a POST request with value, site_id, and token_type to encrypt a token."
  });
} 