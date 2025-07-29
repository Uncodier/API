/**
 * Test de la función comprehensiveEmailFilter OPTIMIZADA
 * Simula el flujo real con 20 emails y mide performance
 */

import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';

// Cargar variables de entorno
config({ path: '.env.local' });

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const SITE_ID = "9be0a6a2-5567-41bf-ad06-cb4014f0faf2";

// Mock de SentEmailDuplicationService.generateEnvelopeBasedId
function generateEnvelopeBasedId(emailData) {
  const { to, from, subject, date } = emailData;
  const dataString = `${date}|${to}|${from}|${subject}`;
  let hash = 0;
  for (let i = 0; i < dataString.length; i++) {
    const char = dataString.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return `env-${Math.abs(hash).toString(16)}-${Date.now()}`;
}

// Simular comprehensiveEmailFilter optimizada
async function testOptimizedEmailFilter(emails, siteId, emailConfig) {
  console.log(`\n🚀 === PROBANDO FILTRO OPTIMIZADO CON ${emails.length} EMAILS ===`);
  
  const startTimeTotal = Date.now();
  
  // 1. Configuración de seguridad (mock)
  const securityConfig = {
    serverUrl: 'https://uncodie.com',
    serverDomain: 'uncodie.com',
    noReplyAddresses: ['noreply@uncodie.com'],
    noReplyPatterns: ['noreply', 'no-reply', 'automated']
  };
  
  // 2. Normalizar aliases
  const normalizedAliases = emailConfig.aliases ? 
    emailConfig.aliases.split(',').map(alias => alias.trim()) : [];
  
  // 3. Generar envelope_ids
  console.log(`[TEST] 🔧 Paso 1: Generando envelope_ids...`);
  const emailToEnvelopeMap = new Map();
  for (const email of emails) {
    const envelopeId = generateEnvelopeBasedId({
      to: email.to,
      from: email.from,
      subject: email.subject,
      date: email.date || new Date().toISOString()
    });
    emailToEnvelopeMap.set(email, envelopeId);
  }
  console.log(`[TEST] ✅ ${emailToEnvelopeMap.size} envelope_ids generados`);
  
  // 4. PASO 1: Filtros básicos (SIN DB) - SÚPER RÁPIDO
  console.log(`[TEST] 🔧 Paso 2: Aplicando filtros básicos (sin DB)...`);
  const stepBasicStart = Date.now();
  
  const stats = {
    originalCount: emails.length,
    feedbackLoopFiltered: 0,
    aliasFiltered: 0,
    duplicateFiltered: 0,
    securityFiltered: 0,
    finalCount: 0,
    aiLeadsFound: 0
  };
  
  const basicFilteredEmails = emails.filter(email => {
    const emailFrom = (email.from || '').toLowerCase();
    const emailTo = (email.to || '').toLowerCase().trim();
    
    // Filtro 1: Feedback loops
    const isAutomated = securityConfig.noReplyPatterns.some(pattern => 
      emailFrom.includes(pattern)
    );
    if (isAutomated) {
      stats.feedbackLoopFiltered++;
      return false;
    }
    
    // Filtro 2: Self-sent
    const fromEmailOnly = emailFrom.match(/<([^>]+)>/) ? emailFrom.match(/<([^>]+)>/)?.[1] : emailFrom;
    const toEmailOnly = emailTo.match(/<([^>]+)>/) ? emailTo.match(/<([^>]+)>/)?.[1] : emailTo;
    if (fromEmailOnly === toEmailOnly) {
      stats.aliasFiltered++;
      return false;
    }
    
    // Filtro 3: Aliases
    if (normalizedAliases.length > 0) {
      const isValidByAlias = normalizedAliases.some(alias => 
        emailTo.includes(alias.toLowerCase())
      );
      if (!isValidByAlias) {
        stats.aliasFiltered++;
        return false;
      }
    }
    
    return true; // Pasa filtros básicos
  });
  
  const stepBasicEnd = Date.now();
  console.log(`[TEST] ✅ Filtros básicos: ${basicFilteredEmails.length}/${emails.length} emails (${stepBasicEnd - stepBasicStart}ms)`);
  
  // 5. PASO 2: Consultas DB SOLO para emails pre-filtrados
  console.log(`[TEST] 🔧 Paso 3: Consultando DB para ${basicFilteredEmails.length} emails pre-filtrados...`);
  const stepDbStart = Date.now();
  
  // 5a. Consulta LEADS
  const fromEmails = basicFilteredEmails.map(email => {
    const fromEmail = (email.from || '').toLowerCase().trim();
    const emailMatch = fromEmail.match(/<([^>]+)>/);
    return emailMatch ? emailMatch[1] : fromEmail;
  }).filter(email => email && email.includes('@'));
  
  let aiLeadsMap = new Map();
  if (fromEmails.length > 0) {
    const leadQueryStart = Date.now();
    try {
      const { data: aiLeads, error } = await supabaseAdmin
        .from('leads')
        .select('id, email, name, assignee_id, status, created_at')
        .eq('site_id', siteId)
        .is('assignee_id', null)
        .in('email', fromEmails);
      
      if (!error && aiLeads) {
        aiLeads.forEach(lead => {
          aiLeadsMap.set(lead.email.toLowerCase(), lead);
        });
      }
      const leadQueryEnd = Date.now();
      console.log(`[TEST] ✅ Consulta LEADS: ${aiLeads?.length || 0} encontrados (${leadQueryEnd - leadQueryStart}ms)`);
    } catch (error) {
      console.warn(`[TEST] ⚠️ Error en consulta LEADS:`, error.message);
    }
  }
  
  stats.aiLeadsFound = aiLeadsMap.size;
  
  // 5b. Consulta SYNCED_OBJECTS
  const envelopeIds = basicFilteredEmails.map(email => emailToEnvelopeMap.get(email)).filter(Boolean);
  let processedEnvelopeIds = new Set();
  
  if (envelopeIds.length > 0) {
    const syncQueryStart = Date.now();
    try {
      const { data: existingObjects, error } = await supabaseAdmin
        .from('synced_objects')
        .select('external_id')
        .eq('site_id', siteId)
        .eq('object_type', 'email')
        .in('external_id', envelopeIds);
      
      if (!error && existingObjects) {
        existingObjects.forEach(obj => processedEnvelopeIds.add(obj.external_id));
      }
      const syncQueryEnd = Date.now();
      console.log(`[TEST] ✅ Consulta SYNCED_OBJECTS: ${existingObjects?.length || 0} encontrados (${syncQueryEnd - syncQueryStart}ms)`);
    } catch (error) {
      console.warn(`[TEST] ⚠️ Error en consulta SYNCED_OBJECTS:`, error.message);
    }
  }
  
  const stepDbEnd = Date.now();
  console.log(`[TEST] ✅ Consultas DB completadas en ${stepDbEnd - stepDbStart}ms`);
  
  // 6. PASO 3: Filtros DB finales
  console.log(`[TEST] 🔧 Paso 4: Aplicando filtros DB finales...`);
  const stepFinalStart = Date.now();
  
  const finalValidEmails = basicFilteredEmails.filter(email => {
    const emailFrom = (email.from || '').toLowerCase();
    const fromEmailAddress = emailFrom.match(/<([^>]+)>/) ? emailFrom.match(/<([^>]+)>/)?.[1] : emailFrom;
    
    // Validación DB 1: Lead asignado a IA (incluir automáticamente)
    if (fromEmailAddress && aiLeadsMap.has(fromEmailAddress)) {
      return true;
    }
    
    // Validación DB 2: Duplicados
    const emailEnvelopeId = emailToEnvelopeMap.get(email);
    if (emailEnvelopeId && processedEnvelopeIds.has(emailEnvelopeId)) {
      stats.duplicateFiltered++;
      return false;
    }
    
    return true;
  });
  
  const stepFinalEnd = Date.now();
  stats.finalCount = finalValidEmails.length;
  
  const endTimeTotal = Date.now();
  const totalTime = endTimeTotal - startTimeTotal;
  
  // Resultados finales
  console.log(`\n[TEST] 📊 === RESULTADOS FILTRO OPTIMIZADO ===`);
  console.log(`[TEST] ⏱️ TIEMPO TOTAL: ${totalTime}ms`);
  console.log(`[TEST] 📈 Emails originales: ${stats.originalCount}`);
  console.log(`[TEST] 🔍 Emails después filtros básicos: ${basicFilteredEmails.length}`);
  console.log(`[TEST] ✅ Emails válidos finales: ${stats.finalCount}`);
  console.log(`[TEST] 🤖 Leads IA encontrados: ${stats.aiLeadsFound}`);
  console.log(`[TEST] 🚫 Filtrados por feedback loops: ${stats.feedbackLoopFiltered}`);
  console.log(`[TEST] 🚫 Filtrados por aliases: ${stats.aliasFiltered}`);
  console.log(`[TEST] 🚫 Filtrados por duplicados: ${stats.duplicateFiltered}`);
  console.log(`[TEST] 🚫 Filtrados por seguridad: ${stats.securityFiltered}`);
  
  // Calcular eficiencia
  const reductionRatio = ((stats.originalCount - basicFilteredEmails.length) / stats.originalCount * 100).toFixed(1);
  console.log(`[TEST] 📉 Reducción por filtros básicos: ${reductionRatio}%`);
  console.log(`[TEST] 🎯 Consultas DB solo para: ${basicFilteredEmails.length} emails (vs ${stats.originalCount} original)`);
  
  return {
    validEmails: finalValidEmails,
    emailToEnvelopeMap,
    summary: stats,
    performance: {
      totalTime,
      basicFilterTime: stepBasicEnd - stepBasicStart,
      dbQueryTime: stepDbEnd - stepDbStart,
      finalFilterTime: stepFinalEnd - stepFinalStart,
      reductionRatio: parseFloat(reductionRatio)
    }
  };
}

// Test principal
async function runOptimizedFilterTest() {
  console.log('\n🧪 === TEST FUNCIÓN COMPREHENSIVEEMAILFILTER OPTIMIZADA ===');
  
  // Simular 20 emails con datos realistas
  const mockEmails = Array.from({ length: 20 }, (_, i) => ({
    id: `email_${i + 1}`,
    from: i < 2 ? 'noreply@automated.com' : `customer${i}@company${i}.com`, // 2 serán filtrados por feedback loop
    to: 'support@uncodie.com',
    subject: `Email ${i + 1}: ${i < 2 ? 'Automated message' : 'Customer inquiry'}`,
    body: `This is email ${i + 1} content`,
    date: new Date().toISOString()
  }));
  
  const mockEmailConfig = {
    aliases: 'support@uncodie.com,ventas@uncodie.com,hola@uncodie.com,contact@uncodie.com'
  };
  
  try {
    const result = await testOptimizedEmailFilter(mockEmails, SITE_ID, mockEmailConfig);
    
    console.log(`\n[TEST] 🎉 === TEST COMPLETADO EXITOSAMENTE ===`);
    console.log(`[TEST] 🚀 Performance total: ${result.performance.totalTime}ms`);
    console.log(`[TEST] 📊 Emails procesados: ${result.summary.originalCount} → ${result.summary.finalCount}`);
    console.log(`[TEST] 📉 Eficiencia: ${result.performance.reductionRatio}% reducción para consultas DB`);
    
    if (result.performance.totalTime < 1000) {
      console.log(`[TEST] ✅ EXCELENTE: Función optimizada es muy rápida (<1s)`);
    } else if (result.performance.totalTime < 5000) {
      console.log(`[TEST] ✅ BUENA: Función optimizada dentro de límites aceptables (<5s)`);
    } else {
      console.log(`[TEST] ⚠️ MEJORABLE: Función toma más de 5s`);
    }
    
  } catch (error) {
    console.error(`\n[TEST] ❌ ERROR en test:`, error);
  }
}

// Ejecutar test
runOptimizedFilterTest()
  .then(() => {
    console.log('\n[TEST] 🏁 Test de filtro optimizado completado');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n[TEST] 💥 Error fatal en test:', error);
    process.exit(1);
  }); 