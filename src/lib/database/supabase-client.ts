import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from './supabase-admin';
export { getSupabaseAdmin, getSupabaseServiceRoleUrl } from './supabase-admin';

let _supabaseInstance: SupabaseClient | null = null;

/**
 * Obtiene o inicializa la conexión lazy a Supabase (Anon)
 */
export const getSupabase = (): SupabaseClient => {
  if (!_supabaseInstance) {
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() || '';
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || '';

    if (!supabaseUrl || !supabaseAnonKey) {
      throw new Error('Supabase URL o Anon Key no están definidas en las variables de entorno. Son necesarias para esta operación.');
    }

    _supabaseInstance = createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: true
      }
    });
  }
  return _supabaseInstance;
};

// Exportamos las variables como Proxies para mantener la retrocompatibilidad
// con todo el código existente que importa `supabase` o `supabaseAdmin` directamente
export const supabase = new Proxy({} as any, {
  get(target, prop) {
    const instance = getSupabase();
    const value = (instance as any)[prop];
    return typeof value === 'function' ? value.bind(instance) : value;
  }
}) as SupabaseClient;

export const supabaseAdmin = new Proxy({} as any, {
  get(target, prop) {
    const instance = getSupabaseAdmin();
    const value = (instance as any)[prop];
    return typeof value === 'function' ? value.bind(instance) : value;
  }
}) as SupabaseClient;

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