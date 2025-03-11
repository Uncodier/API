import { createClient } from '@supabase/supabase-js';

// Obtener las variables de entorno para Supabase
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

// Verificar si las variables de entorno están definidas
if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('Supabase URL o Anon Key no están definidas en las variables de entorno');
}

// Crear y exportar el cliente de Supabase
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
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