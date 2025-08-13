import { supabaseAdmin } from '@/lib/database/supabase-client';

// ------------------------------------------------------------------------------------
// Automation Authentication Helper
// Manages authentication session states for automation instances
// ------------------------------------------------------------------------------------

export interface AuthenticationSession {
  id: string;
  name: string;
  domain: string;
  provider_auth_state_id: string;
  auth_type: string;
  last_used_at: string | null;
  usage_count: number;
  is_valid: boolean;
}

export interface AuthenticationResult {
  success: boolean;
  session?: AuthenticationSession;
  auth_state_id?: string;
  error?: string;
}

/**
 * Busca la sesión de autenticación más reciente para un site_id específico
 */
export async function getLatestAuthSessionForSite(siteId: string): Promise<AuthenticationSession | null> {
  try {
    const { data: session, error } = await supabaseAdmin
      .from('automation_auth_sessions')
      .select('*')
      .eq('site_id', siteId)
      .eq('is_valid', true)
      .order('last_used_at', { ascending: false })
      .limit(1)
      .single();

    if (error || !session) {
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ No authentication session found for site_id: ${siteId}`);
      return null;
    }

    console.log(`₍ᐢ•(ܫ)•ᐢ₎ Found latest auth session: ${session.name} (${session.domain})`);
    return session;
  } catch (error) {
    console.error('Error fetching latest auth session:', error);
    return null;
  }
}

/**
 * Autentica una instancia de navegador usando un estado de autenticación guardado
 */
export async function authenticateBrowserWithSession(
  instanceId: string,
  authStateId: string,
  maxRetries: number = 2
): Promise<{ success: boolean; status?: string; error?: string; errorType?: string }> {
  const scrapybaraApiKey = process.env.SCRAPYBARA_API_KEY;
  if (!scrapybaraApiKey) {
    return { 
      success: false, 
      error: 'SCRAPYBARA_API_KEY not configured',
      errorType: 'configuration_error'
    };
  }

  const authUrl = `https://api.scrapybara.com/v1/instance/${instanceId}/browser/authenticate?auth_state_id=${authStateId}`;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ Authentication attempt ${attempt}/${maxRetries} for instance ${instanceId}`);
      
      const response = await fetch(authUrl, {
        method: 'POST',
        headers: {
          'x-api-key': scrapybaraApiKey,
        },
        // Add timeout to prevent hanging requests
        signal: AbortSignal.timeout(30000) // 30 second timeout
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Error authenticating browser (attempt ${attempt}):`, errorText);
        
        // Categorize errors
        let errorType = 'unknown_error';
        if (response.status === 404) {
          errorType = 'instance_not_found';
        } else if (response.status === 401 || response.status === 403) {
          errorType = 'authentication_invalid';
        } else if (response.status === 422) {
          errorType = 'auth_state_invalid';
        } else if (response.status >= 500) {
          errorType = 'server_error';
        }
        
        // Only retry on server errors and if we have attempts left
        if (errorType === 'server_error' && attempt < maxRetries) {
          console.log(`₍ᐢ•(ܫ)•ᐢ₎ Server error detected, retrying in 2 seconds...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
          continue;
        }
        
        return { 
          success: false, 
          error: `Authentication failed: ${response.status} - ${errorText}`,
          errorType
        };
      }

      const result = await response.json();
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ Browser authentication successful:`, result);
      
      return { 
        success: true, 
        status: result.status 
      };
      
    } catch (error: any) {
      console.error(`Error in browser authentication (attempt ${attempt}):`, error);
      
      // Check if it's a timeout error
      if (error.name === 'TimeoutError' || error.name === 'AbortError') {
        if (attempt < maxRetries) {
          console.log(`₍ᐢ•(ܫ)•ᐢ₎ Timeout detected, retrying...`);
          continue;
        }
        return { 
          success: false, 
          error: 'Authentication request timed out',
          errorType: 'timeout_error'
        };
      }
      
      // Network or other errors
      if (attempt < maxRetries) {
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ Network error detected, retrying in 2 seconds...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
        continue;
      }
      
      return { 
        success: false, 
        error: `Authentication error: ${error.message}`,
        errorType: 'network_error'
      };
    }
  }
  
  // This should never be reached, but just in case
  return { 
    success: false, 
    error: 'Authentication failed after all retry attempts',
    errorType: 'retry_exhausted'
  };
}

/**
 * Busca y aplica automáticamente la autenticación más reciente para un site_id
 */
export async function autoAuthenticateInstance(
  instanceId: string, 
  siteId: string
): Promise<AuthenticationResult> {
  try {
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ Starting auto-authentication for site ${siteId}, instance ${instanceId}`);
    
    // 1. Buscar la sesión más reciente
    const latestSession = await getLatestAuthSessionForSite(siteId);
    
    if (!latestSession) {
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ No authentication sessions found for site ${siteId}`);
      return {
        success: false,
        error: 'No valid authentication session found for this site'
      };
    }

    if (!latestSession.provider_auth_state_id) {
      console.warn(`₍ᐢ•(ܫ)•ᐢ₎ Session ${latestSession.name} has no provider_auth_state_id`);
      return {
        success: false,
        session: latestSession,
        error: 'Authentication session does not have provider_auth_state_id'
      };
    }

    console.log(`₍ᐢ•(ܫ)•ᐢ₎ Found session: ${latestSession.name} with auth_state_id: ${latestSession.provider_auth_state_id}`);

    // 2. Aplicar la autenticación
    const authResult = await authenticateBrowserWithSession(
      instanceId, 
      latestSession.provider_auth_state_id
    );

    if (!authResult.success) {
      console.warn(`₍ᐢ•(ܫ)•ᐢ₎ Authentication failed: ${authResult.error} (${authResult.errorType})`);
      
      // Mark session as invalid if the auth state is invalid
      if (authResult.errorType === 'auth_state_invalid') {
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ Marking session as invalid due to invalid auth state`);
        await markSessionInvalid(latestSession.id, authResult.error);
      }
      
      return {
        success: false,
        session: latestSession,
        error: authResult.error,
        auth_state_id: latestSession.provider_auth_state_id
      };
    }

    // 3. Actualizar estadísticas de uso de la sesión
    await updateSessionUsage(latestSession.id);

    console.log(`₍ᐢ•(ܫ)•ᐢ₎ ✅ Auto-authentication successful for site ${siteId} using session ${latestSession.name}`);
    
    return {
      success: true,
      session: latestSession,
      auth_state_id: latestSession.provider_auth_state_id
    };
  } catch (error: any) {
    console.error('Error in auto-authentication:', error);
    return {
      success: false,
      error: `Auto-authentication failed: ${error.message}`
    };
  }
}

/**
 * Actualiza las estadísticas de uso de una sesión de autenticación
 */
async function updateSessionUsage(sessionId: string): Promise<void> {
  try {
    // Use SQL expression to increment usage_count
    await supabaseAdmin
      .from('automation_auth_sessions')
      .update({
        last_used_at: new Date().toISOString()
      })
      .eq('id', sessionId);

    // Update usage count manually since we don't have the RPC function yet
    const { data: currentSession } = await supabaseAdmin
      .from('automation_auth_sessions')
      .select('usage_count')
      .eq('id', sessionId)
      .single();
    
    if (currentSession) {
      await supabaseAdmin
        .from('automation_auth_sessions')
        .update({ usage_count: (currentSession.usage_count || 0) + 1 })
        .eq('id', sessionId);
    }

    console.log(`₍ᐢ•(ܫ)•ᐢ₎ Updated session usage statistics for session: ${sessionId}`);
  } catch (error) {
    console.error('Error updating session usage:', error);
    // No fallar el proceso principal por este error
  }
}

/**
 * Marca una sesión como inválida cuando falla la autenticación
 */
async function markSessionInvalid(sessionId: string, reason?: string): Promise<void> {
  try {
    await supabaseAdmin
      .from('automation_auth_sessions')
      .update({
        is_valid: false,
        updated_at: new Date().toISOString(),
        // Optionally store the reason in a metadata field if it exists
      })
      .eq('id', sessionId);

    console.log(`₍ᐢ•(ܫ)•ᐢ₎ Marked session ${sessionId} as invalid. Reason: ${reason}`);
  } catch (error) {
    console.error('Error marking session as invalid:', error);
    // No fallar el proceso principal por este error
  }
}

/**
 * Obtiene todas las sesiones de autenticación válidas para un site_id
 */
export async function getAllAuthSessionsForSite(siteId: string): Promise<AuthenticationSession[]> {
  try {
    const { data: sessions, error } = await supabaseAdmin
      .from('automation_auth_sessions')
      .select('*')
      .eq('site_id', siteId)
      .eq('is_valid', true)
      .order('last_used_at', { ascending: false });

    if (error) {
      console.error('Error fetching auth sessions:', error);
      return [];
    }

    return sessions || [];
  } catch (error) {
    console.error('Error in getAllAuthSessionsForSite:', error);
    return [];
  }
}
