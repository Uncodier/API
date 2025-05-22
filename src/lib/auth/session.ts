import { supabase } from '@/lib/database/supabase-client';

// ID de prueba constante para desarrollo
const TEST_USER_ID = '123e4567-e89b-12d3-a456-426614174000';

export async function getSession() {
  try {
    const { data: { session }, error } = await supabase.auth.getSession();
    
    if (error) {
      console.error('🔐 Error obteniendo sesión:', error.message);
      return null;
    }
    
    if (!session?.user) {
      console.log('🔐 No hay sesión activa');
      return null;
    }

    return {
      user: {
        id: session.user.id,
        email: session.user.email,
        name: session.user.user_metadata?.name
      }
    };
  } catch (error) {
    console.error('🔐 Error inesperado al obtener sesión:', error);
    return null;
  }
} 