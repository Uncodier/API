import { createClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';

// Obtener las variables de entorno para Supabase
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

/**
 * Crea un cliente de Supabase para API routes que respeta el authorization header
 * @param request NextRequest object
 * @returns Supabase client configurado con el token del usuario si existe
 */
export function createSupabaseClient(request: NextRequest) {
  // Verificar si viene con API key (del middleware)
  const apiKeyData = request.headers.get('x-api-key-data');
  if (apiKeyData) {
    console.log('[Supabase] Using service role client for API key request');
    // Si viene con API key, usar el cliente admin
    return createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });
  }

  // Intentar obtener el token del authorization header
  const authHeader = request.headers.get('authorization');
  
  if (authHeader) {
    // Extraer el token (soportar formato "Bearer token")
    const token = authHeader.startsWith('Bearer ') 
      ? authHeader.substring(7) 
      : authHeader;

    console.log('[Supabase] Using anon client with user token');
    
    // Crear cliente con el token del usuario
    return createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      },
      global: {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    });
  }

  console.log('[Supabase] Using anon client without auth');
  // Si no hay auth, crear cliente normal
  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
}

/**
 * Cliente admin para operaciones que requieren permisos elevados
 */
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
}); 