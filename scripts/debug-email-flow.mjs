/**
 * Script de debug para rastrear el flujo completo del email
 */

// Simular la lógica de SentEmailDuplicationService.generateEnvelopeBasedId()
function simulateSentEmailDuplicationService(email) {
  try {
    // Extraer datos requeridos
    const to = email.to || email.recipient;
    const from = email.from || email.sender;
    const subject = email.subject;
    const date = email.date || email.sent_at;
    
    if (!to || !from || !subject || !date) {
      return null;
    }
    
    // Normalizar timestamp
    const timestamp = new Date(date);
    if (isNaN(timestamp.getTime())) {
      return null;
    }
    
    // Redondear a DÍA
    const roundedTime = new Date(timestamp);
    roundedTime.setHours(0, 0, 0, 0);
    const timeWindow = roundedTime.toISOString().substring(0, 10);
    
    // Normalizar campos
    const normalizedTo = extractEmailAddress(to).toLowerCase().trim();
    const normalizedFrom = extractEmailAddress(from).toLowerCase().trim();
    const normalizedSubject = subject.toLowerCase().trim().substring(0, 50);
    
    // Crear string de datos para hash
    const dataString = `${normalizedTo}|${normalizedFrom}|${normalizedSubject}|${timeWindow}`;
    
    // Generar hash
    let hash = 0;
    for (let i = 0; i < dataString.length; i++) {
      const char = dataString.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    
    // Crear envelope ID
    const envelopeId = `env-${Math.abs(hash).toString(16)}-${timeWindow.replace(/-/g, '')}`;
    
    return envelopeId;
    
  } catch (error) {
    return null;
  }
}

// Función auxiliar para extraer dirección de email
function extractEmailAddress(emailField) {
  if (!emailField) return '';
  
  // Si ya es una dirección de email simple
  if (emailField.includes('@') && !emailField.includes('<')) {
    return emailField;
  }
  
  // Extraer de formato "Name <email@domain.com>"
  const match = emailField.match(/<([^>]+)>/);
  if (match) {
    return match[1];
  }
  
  // Buscar patrones de email en el texto
  const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const emails = emailField.match(emailPattern);
  
  if (emails && emails.length > 0) {
    return emails[0];
  }
  
  return emailField;
}

// Simular el flujo completo
function simulateCompleteEmailFlow(email, siteId, emailConfig) {
  console.log('🚀 SIMULANDO FLUJO COMPLETO DE EMAIL\n');
  
  // 1. GENERAR ENVELOPE ID
  console.log('1️⃣ Generando envelope ID...');
  const envelopeId = simulateSentEmailDuplicationService(email);
  console.log(`   Envelope ID: ${envelopeId}`);
  console.log('');
  
  // 2. VERIFICAR FILTROS BÁSICOS
  console.log('2️⃣ Aplicando filtros básicos...');
  
  // 2.1 Verificar si es email enviado desde nuestro dominio
  const fromEmail = extractEmailAddress(email.from).toLowerCase();
  const toEmail = extractEmailAddress(email.to).toLowerCase();
  
  const isFromOurDomain = fromEmail.includes('@uncodie.com');
  const isToExternal = !toEmail.includes('@uncodie.com');
  
  if (isFromOurDomain && isToExternal) {
    console.log(`   ❌ FILTRADO: Email enviado desde nuestro dominio hacia externo`);
    console.log(`      From: ${fromEmail} (nuestro dominio)`);
    console.log(`      To: ${toEmail} (externo)`);
    return { filtered: true, reason: 'email_enviado_desde_nuestro_dominio' };
  }
  
  // 2.2 Verificar self-sent
  if (fromEmail === toEmail) {
    console.log(`   ❌ FILTRADO: Email self-sent`);
    console.log(`      From: ${fromEmail}`);
    console.log(`      To: ${toEmail}`);
    return { filtered: true, reason: 'self_sent' };
  }
  
  // 2.3 Verificar aliases
  const normalizedAliases = emailConfig.aliases || [];
  const isToAlias = normalizedAliases.includes(toEmail);
  
  if (isToAlias) {
    console.log(`   ✅ Email a alias detectado: ${toEmail}`);
  } else {
    console.log(`   ⚠️ Email NO es a alias: ${toEmail}`);
    console.log(`      Aliases configurados: [${normalizedAliases.join(', ')}]`);
  }
  
  console.log('   ✅ Filtros básicos pasados');
  console.log('');
  
  // 3. VERIFICAR DUPLICADOS
  console.log('3️⃣ Verificando duplicados...');
  
  // Simular que NO hay duplicados (email nuevo)
  const processedEnvelopeIds = new Set();
  const isDuplicate = processedEnvelopeIds.has(envelopeId);
  
  if (isDuplicate) {
    console.log(`   ❌ FILTRADO: Email duplicado`);
    console.log(`      Envelope ID: ${envelopeId}`);
    return { filtered: true, reason: 'duplicado' };
  }
  
  console.log(`   ✅ No es duplicado (envelope ID: ${envelopeId})`);
  console.log('');
  
  // 4. VERIFICAR LEADS IA
  console.log('4️⃣ Verificando leads IA...');
  
  // Simular AI leads map (vacío para este caso)
  const aiLeadsMap = new Map();
  const isFromAILead = aiLeadsMap.has(fromEmail);
  
  if (isFromAILead) {
    console.log(`   🤖 Lead IA detectado: ${fromEmail}`);
  } else {
    console.log(`   👤 No es lead IA: ${fromEmail}`);
  }
  
  console.log('');
  
  // 5. RESULTADO FINAL
  console.log('5️⃣ Resultado final...');
  console.log(`   ✅ EMAIL VÁLIDO - Será procesado`);
  console.log(`   Tipo: ${isToAlias ? 'Email a alias' : isFromAILead ? 'Email de lead IA' : 'Email normal'}`);
  console.log(`   Envelope ID: ${envelopeId}`);
  
  return { 
    filtered: false, 
    envelopeId: envelopeId,
    type: isToAlias ? 'alias' : isFromAILead ? 'ai_lead' : 'normal'
  };
}

// Test principal
async function debugEmailFlow() {
  console.log('🧪 DEBUG: Flujo completo de email\n');

  // Email de prueba (el caso real del usuario)
  const testEmail = {
    from: 'Sergio Prado via Hola Uncodie',
    to: 'hola@uncodie.com',
    subject: 'info',
    date: '2025-08-29T22:10:00Z',
    body: 'hola, me llego un correo con info de sus agentes, y quisiera más detalles.'
  };

  // Configuración de email
  const emailConfig = {
    aliases: ['hola@uncodie.com', 'ventas@uncodie.com']
  };

  const siteId = 'test-site';

  console.log('📧 Email de prueba:');
  console.log(`  From: "${testEmail.from}"`);
  console.log(`  To: "${testEmail.to}"`);
  console.log(`  Subject: "${testEmail.subject}"`);
  console.log(`  Date: "${testEmail.date}"`);
  console.log('');

  console.log('📋 Configuración:');
  console.log(`  - Site ID: ${siteId}`);
  console.log(`  - Aliases: [${emailConfig.aliases.join(', ')}]`);
  console.log('');

  try {
    const result = simulateCompleteEmailFlow(testEmail, siteId, emailConfig);
    
    console.log('\n🔍 VERIFICACIÓN DE RESULTADOS:');
    if (result.filtered) {
      console.log(`❌ EMAIL FILTRADO: ${result.reason}`);
      console.log(`   El email no se procesará debido a: ${result.reason}`);
    } else {
      console.log(`✅ EMAIL VÁLIDO: ${result.type}`);
      console.log(`   El email será procesado correctamente`);
      console.log(`   Envelope ID: ${result.envelopeId}`);
    }

    console.log('\n📊 RESUMEN:');
    console.log(`   - Email procesado: ${!result.filtered ? '✅' : '❌'}`);
    console.log(`   - Razón: ${result.filtered ? result.reason : 'N/A'}`);
    console.log(`   - Tipo: ${result.type || 'N/A'}`);

  } catch (error) {
    console.error('❌ Error durante el debug:', error);
  }
}

// Ejecutar debug
debugEmailFlow().catch(console.error);
