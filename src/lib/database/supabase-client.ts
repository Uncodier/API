import { createClient } from '@supabase/supabase-js';

// Obtener las variables de entorno para Supabase
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// Verificar si las variables de entorno están definidas
if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('⚠️ Supabase URL o Anon Key no están definidas en las variables de entorno');
}

if (!supabaseServiceRoleKey) {
  console.warn('⚠️ Supabase Service Role Key no está definida en las variables de entorno');
}

// Crear y exportar el cliente normal usando la anon key
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true
  }
});

// Crear y exportar el cliente admin usando la service role key
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

// Función para verificar la conexión a Supabase
export async function checkSupabaseConnection(): Promise<boolean> {
  try {
    // Intentar una operación simple para verificar la conexión
    const { data, error } = await supabase.from('segments').select('id').limit(1);
    
    if (error) {
      console.error('Error al conectar con Supabase:', error);
      return false;
    }
    
    console.log('Conexión a Supabase establecida correctamente');
    return true;
  } catch (error) {
    console.error('Error al verificar la conexión a Supabase:', error);
    return false;
  }
} 