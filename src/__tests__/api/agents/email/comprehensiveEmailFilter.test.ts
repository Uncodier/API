/**
 * Test de debugging para comprehensiveEmailFilter
 * Objetivo: Identificar exactamente dónde se está colgando la función
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Mock de supabaseAdmin
const mockSupabaseAdmin = {
  from: jest.fn().mockReturnThis(),
  select: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  is: jest.fn().mockReturnThis(),
  in: jest.fn().mockReturnThis(),
};

// Mock de process.env
const originalEnv = process.env;

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: mockSupabaseAdmin
}));

// Función getSecurityConfig extraída del código principal
function getSecurityConfig() {
  console.log('[TEST] 🔧 Iniciando getSecurityConfig...');
  
  const serverUrl = process.env.NEXT_PUBLIC_ORIGIN || 
                   process.env.VERCEL_URL || 
                   process.env.NEXT_PUBLIC_APP_URL || 
                   'http://localhost:3000';
  
  console.log('[TEST] 🔧 serverUrl obtenido:', serverUrl);
  
  const serverDomain = (() => {
    try {
      const urlObj = new URL(serverUrl.startsWith('http') ? serverUrl : `https://${serverUrl}`);
      console.log('[TEST] 🔧 URL parseada exitosamente');
      return urlObj.hostname.toLowerCase();
    } catch (error) {
      console.log('[TEST] ⚠️ Error parseando URL:', error);
      return null;
    }
  })();
  
  console.log('[TEST] 🔧 serverDomain obtenido:', serverDomain);

  const noReplyAddresses = [
    process.env.EMAIL_FROM,
    process.env.SENDGRID_FROM_EMAIL,
    process.env.NO_REPLY_EMAILS,
    'no-reply@uncodie.com',
    'noreply@uncodie.com'
  ].filter(Boolean).flatMap(addr => 
    addr && typeof addr === 'string' ? 
      (addr.includes(',') ? addr.split(',').map(a => a.trim()) : [addr]) : []
  );

  console.log('[TEST] 🔧 noReplyAddresses generadas:', noReplyAddresses.length);

  const result = {
    serverUrl: serverUrl.startsWith('http') ? serverUrl : `https://${serverUrl}`,
    serverDomain,
    noReplyAddresses: Array.from(new Set(noReplyAddresses)),
    noReplyPatterns: [
      'noreply', 'no-reply', 'donotreply', 'do-not-reply',
      'mailer-daemon', 'postmaster@', 'automated@', 'system@', 'daemon@'
    ]
  };
  
  console.log('[TEST] ✅ getSecurityConfig completado');
  return result;
}

// Función comprehensiveEmailFilter adaptada para testing
async function comprehensiveEmailFilter(
  emails: any[], 
  siteId: string, 
  emailConfig: any
): Promise<{
  validEmails: any[], 
  summary: {
    originalCount: number,
    feedbackLoopFiltered: number,
    aliasFiltered: number,
    duplicateFiltered: number,
    securityFiltered: number,
    finalCount: number,
    aiLeadsFound: number
  }
}> {
  console.log(`[TEST] 🔍 Aplicando filtro comprehensivo a ${emails.length} emails...`);
  
  // 1. Obtener configuraciones una sola vez
  console.log(`[TEST] 🔧 Paso 1: Obteniendo configuraciones de seguridad...`);
  let securityConfig;
  try {
    securityConfig = getSecurityConfig();
    console.log(`[TEST] ✅ Paso 1 completado: Configuraciones obtenidas`);
  } catch (error: unknown) {
    console.error(`[TEST] ❌ Error en Paso 1:`, error instanceof Error ? error.message : String(error));
    throw error;
  }
  
  // 2. Normalizar aliases una sola vez
  console.log(`[TEST] 🔧 Paso 2: Normalizando aliases...`);
  let normalizedAliases: string[] = [];
  try {
    if (emailConfig.aliases) {
      if (Array.isArray(emailConfig.aliases)) {
        normalizedAliases = emailConfig.aliases;
      } else {
        const aliasesStr = String(emailConfig.aliases);
        if (aliasesStr.trim().length > 0) {
          normalizedAliases = aliasesStr
            .split(',')
            .map((alias: string) => alias.trim())
            .filter((alias: string) => alias.length > 0);
        }
      }
    }
    console.log(`[TEST] ✅ Paso 2 completado: ${normalizedAliases.length} aliases normalizados`);
  } catch (error) {
    console.error(`[TEST] ❌ Error en Paso 2:`, error);
    throw error;
  }
  
  // 3. Buscar leads asignados a IA una sola vez
  console.log(`[TEST] 🔧 Paso 3: Extrayendo direcciones de email para buscar leads...`);
  let emailAddresses: string[];
  let aiLeadsMap: Map<string, any>;
  try {
    emailAddresses = emails.map(email => {
      const fromEmail = (email.from || '').toLowerCase().trim();
      const emailMatch = fromEmail.match(/<([^>]+)>/);
      return emailMatch ? emailMatch[1] : fromEmail;
    }).filter(email => email && email.includes('@'));
    console.log(`[TEST] ✅ Paso 3a completado: ${emailAddresses.length} direcciones de email extraídas`);
    
    console.log(`[TEST] 🔧 Paso 3b: Consultando leads asignados a IA en base de datos...`);
    aiLeadsMap = new Map<string, any>();
    if (emailAddresses.length > 0) {
      console.log(`[TEST] 🔧 Haciendo consulta a supabase con ${emailAddresses.length} direcciones...`);
      
      // Simular una consulta que podría estar colgándose
      const queryResult = await mockSupabaseAdmin
        .from('leads')
        .select('id, email, name, assignee_id, status, created_at')
        .eq('site_id', siteId)
        .is('assignee_id', null)
        .in('email', emailAddresses);
      
      console.log(`[TEST] ✅ Consulta a supabase completada`);
      
      // Simular resultados
      if (queryResult && !queryResult.error) {
        const mockAiLeads = emailAddresses.slice(0, 2).map((email, index) => ({
          id: `lead_${index}`,
          email: email,
          name: `Test Lead ${index}`,
          assignee_id: null,
          status: 'active',
          created_at: new Date().toISOString()
        }));
        
        mockAiLeads.forEach(lead => {
          aiLeadsMap.set(lead.email.toLowerCase(), lead);
        });
      }
      
      console.log(`[TEST] ✅ Paso 3b completado: ${aiLeadsMap.size} leads asignados a IA encontrados`);
    } else {
      console.log(`[TEST] ⚠️ Paso 3b: No hay direcciones de email válidas para consultar leads`);
    }
  } catch (error: unknown) {
    console.error(`[TEST] ❌ Error en Paso 3:`, error);
    throw error;
  }
  
  // 4. Obtener emails ya procesados una sola vez (OPTIMIZADO - consulta única)
  console.log(`[TEST] 🔧 Paso 4: Consultando emails ya procesados...`);
  let processedEmailIds = new Set<string>();
  try {
    // Extraer todos los IDs para consulta en batch
    const emailIds = emails.map(email => email.id || email.messageId || email.uid).filter(Boolean);
    console.log(`[TEST] 🔧 Paso 4a: ${emailIds.length} IDs de email extraídos para verificar duplicados`);
    
    if (emailIds.length > 0) {
      console.log(`[TEST] 🔧 Haciendo consulta a synced_objects...`);
      
      const queryResult = await mockSupabaseAdmin
        .from('synced_objects')
        .select('external_id')
        .eq('site_id', siteId)
        .eq('object_type', 'email')
        .in('external_id', emailIds);
      
      console.log(`[TEST] ✅ Consulta a synced_objects completada`);
      
      // Simular algunos emails ya procesados
      const mockProcessedIds = emailIds.slice(0, 1); // Simular que 1 email ya fue procesado
      mockProcessedIds.forEach(id => processedEmailIds.add(id));
      
      console.log(`[TEST] ✅ Paso 4 completado: ${mockProcessedIds.length} emails ya procesados encontrados`);
    } else {
      console.log(`[TEST] ⚠️ Paso 4: No hay IDs válidos para verificar duplicados`);
    }
  } catch (error) {
    console.error(`[TEST] ❌ Error en Paso 4:`, error);
    throw error;
  }
  
  // 5. UN SOLO recorrido aplicando TODAS las validaciones
  console.log(`[TEST] 🔧 Paso 5: Iniciando recorrido de validación de ${emails.length} emails...`);
  const stats = {
    originalCount: emails.length,
    feedbackLoopFiltered: 0,
    aliasFiltered: 0,
    duplicateFiltered: 0,
    securityFiltered: 0,
    finalCount: 0,
    aiLeadsFound: aiLeadsMap.size
  };
  
  let validEmails;
  try {
    validEmails = emails.filter((email, index) => {
      console.log(`[TEST] 🔧 Procesando email ${index + 1}/${emails.length}...`);
      
      const emailContent = (email.body || email.text || '').toLowerCase();
      const emailSubject = (email.subject || '').toLowerCase();
      const emailFrom = (email.from || '').toLowerCase();
      const emailTo = (email.to || '').toLowerCase().trim();
      const emailId = email.id || email.messageId || email.uid;
      
      // Simular validaciones paso a paso
      console.log(`[TEST] 🔧 Email ${index + 1}: Validando feedback loops...`);
      // VALIDACIÓN 1: Feedback Loops (simplificada para test)
      const isAutomated = securityConfig.noReplyPatterns.some(pattern => 
        emailFrom.includes(pattern) || emailSubject.includes(pattern)
      );
      
      if (isAutomated) {
        stats.feedbackLoopFiltered++;
        console.log(`[TEST] 🚫 Email ${index + 1} filtrado (feedback loop): ${email.from}`);
        return false;
      }
      
      console.log(`[TEST] 🔧 Email ${index + 1}: Validando duplicados...`);
      // VALIDACIÓN 2: Duplicados
      if (emailId && processedEmailIds.has(emailId)) {
        stats.duplicateFiltered++;
        console.log(`[TEST] 🚫 Email ${index + 1} filtrado (duplicado): ${emailId}`);
        return false;
      }
      
      console.log(`[TEST] 🔧 Email ${index + 1}: Validando leads IA...`);
      // VALIDACIÓN 3: Leads asignados a IA
      const fromEmailAddress = emailFrom.match(/<([^>]+)>/) ? emailFrom.match(/<([^>]+)>/)?.[1] : emailFrom;
      if (fromEmailAddress && aiLeadsMap.has(fromEmailAddress)) {
        console.log(`[TEST] 🤖 Email ${index + 1} de lead asignado a IA (incluido automáticamente)`);
        return true;
      }
      
      console.log(`[TEST] 🔧 Email ${index + 1}: Validando aliases...`);
      // VALIDACIÓN 4: Aliases (simplificada)
      if (normalizedAliases.length > 0) {
        const isValidByAlias = normalizedAliases.some(alias => 
          emailTo.includes(alias.toLowerCase())
        );
        
        if (!isValidByAlias) {
          stats.aliasFiltered++;
          console.log(`[TEST] 🚫 Email ${index + 1} filtrado (no coincide con aliases): ${email.from}`);
          return false;
        }
      }
      
      console.log(`[TEST] ✅ Email ${index + 1} válido: ${email.from}`);
      return true;
    });
    
    console.log(`[TEST] ✅ Paso 5 completado: Recorrido de validación terminado`);
  } catch (error) {
    console.error(`[TEST] ❌ Error en Paso 5:`, error);
    throw error;
  }
  
  stats.finalCount = validEmails.length;
  
  console.log(`[TEST] 📊 Filtro comprehensivo completado:`);
  console.log(`[TEST] - Emails originales: ${stats.originalCount}`);
  console.log(`[TEST] - Emails válidos finales: ${stats.finalCount}`);
  
  return {
    validEmails,
    summary: stats
  };
}

describe('Comprehensive Email Filter Debugging', () => {
  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();
    
    // Setup mock responses para supabase
    mockSupabaseAdmin.from.mockReturnValue({
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          is: jest.fn().mockReturnValue({
            in: jest.fn().mockResolvedValue({
              data: [],
              error: null
            })
          }),
          eq: jest.fn().mockReturnValue({
            in: jest.fn().mockResolvedValue({
              data: [],
              error: null
            })
          })
        })
      })
    });
    
    // Setup environment variables
    process.env = {
      ...originalEnv,
      NEXT_PUBLIC_ORIGIN: 'https://test.uncodie.com',
      EMAIL_FROM: 'test@uncodie.com',
      SENDGRID_FROM_EMAIL: 'noreply@uncodie.com'
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  it('should complete getSecurityConfig without hanging', () => {
    console.log('[TEST] 🚀 Iniciando test de getSecurityConfig...');
    
    const startTime = Date.now();
    const result = getSecurityConfig();
    const endTime = Date.now();
    
    console.log(`[TEST] ⏱️ getSecurityConfig completado en ${endTime - startTime}ms`);
    
    expect(result).toBeDefined();
    expect(result.serverUrl).toBe('https://test.uncodie.com');
    expect(result.serverDomain).toBe('test.uncodie.com');
    expect(result.noReplyAddresses).toContain('test@uncodie.com');
    expect(result.noReplyPatterns).toContain('noreply');
  });

  it('should complete comprehensive filter with minimal data', async () => {
    console.log('[TEST] 🚀 Iniciando test de filtro comprehensivo con datos mínimos...');
    
    const mockEmails = [
      {
        id: 'test_1',
        from: 'customer@test.com',
        to: 'support@uncodie.com',
        subject: 'Test email',
        body: 'This is a test email'
      }
    ];
    
    const mockEmailConfig = {
      aliases: ['support@uncodie.com']
    };
    
    const startTime = Date.now();
    
    try {
      const result = await comprehensiveEmailFilter(mockEmails, 'test-site-123', mockEmailConfig);
      const endTime = Date.now();
      
      console.log(`[TEST] ⏱️ comprehensiveEmailFilter completado en ${endTime - startTime}ms`);
      console.log(`[TEST] 📊 Resultado:`, result.summary);
      
      expect(result).toBeDefined();
      expect(result.validEmails).toBeDefined();
      expect(result.summary).toBeDefined();
      expect(result.summary.originalCount).toBe(1);
      
    } catch (error) {
      const endTime = Date.now();
      console.error(`[TEST] ❌ Error después de ${endTime - startTime}ms:`, error);
      throw error;
    }
  });

  it('should handle empty emails array', async () => {
    console.log('[TEST] 🚀 Iniciando test con array vacío...');
    
    const startTime = Date.now();
    const result = await comprehensiveEmailFilter([], 'test-site-123', {});
    const endTime = Date.now();
    
    console.log(`[TEST] ⏱️ Test con array vacío completado en ${endTime - startTime}ms`);
    
    expect(result.validEmails).toHaveLength(0);
    expect(result.summary.originalCount).toBe(0);
  });

  it('should timeout if supabase query hangs', async () => {
    console.log('[TEST] 🚀 Iniciando test de timeout en consulta supabase...');
    
    // Mock que simula una consulta que nunca resuelve
    mockSupabaseAdmin.from.mockReturnValue({
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          is: jest.fn().mockReturnValue({
            in: jest.fn().mockImplementation(() => {
              console.log('[TEST] 🔧 Simulando consulta que se cuelga...');
              return new Promise(() => {}); // Promise que nunca resuelve
            })
          })
        })
      })
    });
    
    const mockEmails = [
      {
        id: 'test_1',
        from: 'customer@test.com',
        to: 'support@uncodie.com',
        subject: 'Test email',
        body: 'This is a test email'
      }
    ];
    
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('TEST_TIMEOUT')), 5000); // 5 segundos timeout
    });
    
    try {
      await Promise.race([
        comprehensiveEmailFilter(mockEmails, 'test-site-123', {}),
        timeoutPromise
      ]);
      
      // Si llega aquí, no hubo timeout
      console.log('[TEST] ⚠️ No hubo timeout - la función completó normalmente');
      
    } catch (error) {
      if (error instanceof Error && error.message === 'TEST_TIMEOUT') {
        console.log('[TEST] ⏰ TIMEOUT detectado - la consulta se está colgando');
        expect(error.message).toBe('TEST_TIMEOUT');
      } else {
        console.log('[TEST] ❌ Error diferente al timeout:', error);
        throw error;
      }
    }
  }, 10000); // 10 segundos timeout para Jest
}); 