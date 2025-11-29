/**
 * Test script para verificar que la corrección del filtro de alias funciona
 */

// Simular la lógica de isValidByAlias
function simulateIsValidByAlias(email, emailTo, normalizedAliases) {
  const emailFrom = (email.from || '').toLowerCase();
  
  const destinationFields = [
    emailTo,
    email.headers?.['delivered-to']?.toLowerCase?.().trim?.() || '',
    email.headers?.['x-original-to']?.toLowerCase?.().trim?.() || '',
    email.headers?.['x-envelope-to']?.toLowerCase?.().trim?.() || '',
    email.headers?.['x-rcpt-to']?.toLowerCase?.().trim?.() || '',
    email.headers?.['envelope-to']?.toLowerCase?.().trim?.() || ''
  ].filter(field => field && field.length > 0);

  const isValidByAlias = normalizedAliases.some(alias => {
    const normalizedAlias = alias.toLowerCase().trim();
    
    const matchResult = destinationFields.some(destinationField => {
      const normalizedField = destinationField.toLowerCase().trim();
      
      if (normalizedField === normalizedAlias || normalizedField.includes(normalizedAlias)) {
        return true;
      }
      
      // Verificar formato <email>
      const emailMatches = normalizedField.match(/<([^>]+)>/g);
      if (emailMatches) {
        const matchResult = emailMatches.some((match) => {
          const extractedEmail = match.replace(/[<>]/g, '').trim();
          return extractedEmail === normalizedAlias;
        });
        if (matchResult) return true;
      }
      
      // Verificar lista separada por comas
      if (normalizedField.includes(',')) {
        const emailList = normalizedField.split(',').map((e) => e.trim());
        const listMatchResult = emailList.some((singleEmail) => {
          const cleanEmail = singleEmail.replace(/.*<([^>]+)>.*/, '$1').trim();
          return cleanEmail === normalizedAlias || singleEmail === normalizedAlias;
        });
        if (listMatchResult) return true;
      }
      
      return false;
    });
    
    return matchResult;
  });
  
  return isValidByAlias;
}

// Simular la lógica CORREGIDA del filtro de alias
function simulateCorrectedAliasFilter(email, emailTo, normalizedAliases, aiLeadsMap) {
  console.log(`[COMPREHENSIVE_FILTER] 🔍 Verificando email: ${email.from} → ${emailTo}`);
  
  // Verificar si es de un lead IA conocido - bypass de filtro de alias
  const fromEmailAddress = email.from.toLowerCase();
  const isFromAILead = aiLeadsMap.has(fromEmailAddress);
  
  if (isFromAILead) {
    console.log(`[COMPREHENSIVE_FILTER] 🤖 BYPASS: Email de lead IA (${fromEmailAddress}) → ${emailTo} - ignora validación de alias`);
    return { included: true, reason: 'ai_lead_bypass' };
  }
  
  // 🎯 CORREGIR LÓGICA: Incluir emails que coinciden con aliases
  const isValidByAlias = simulateIsValidByAlias(email, emailTo, normalizedAliases);
  if (isValidByAlias) {
    console.log(`[COMPREHENSIVE_FILTER] ✅ Email a alias incluido: ${emailTo}`);
    return { included: true, reason: 'alias_match' };
  } else {
    console.log(`[COMPREHENSIVE_FILTER] ❌ Email filtrado (no coincide con aliases): TO=${emailTo}`);
    return { included: false, reason: 'no_alias_match' };
  }
}

// Test principal
async function testAliasFilterFix() {
  console.log('🧪 TEST: Verificación de corrección del filtro de alias\n');

  // Emails de prueba
  const testEmails = [
    {
      name: 'Email a alias válido',
      from: 'Sergio Prado via Hola Uncodie',
      to: 'hola@uncodie.com',
      subject: 'info',
      date: '2025-08-29T22:10:00Z'
    },
    {
      name: 'Email a alias válido (formato diferente)',
      from: 'cliente@example.com',
      to: 'ventas@uncodie.com',
      subject: 'Consulta',
      date: '2025-08-29T22:15:00Z'
    },
    {
      name: 'Email NO a alias',
      from: 'otro@example.com',
      to: 'otro@example.com',
      subject: 'Spam',
      date: '2025-08-29T22:20:00Z'
    },
    {
      name: 'Email de lead IA',
      from: 'sergio.prado@me.com',
      to: 'cualquier@uncodie.com',
      subject: 'Lead IA',
      date: '2025-08-29T22:25:00Z'
    }
  ];

  // Configuración
  const normalizedAliases = ['hola@uncodie.com', 'ventas@uncodie.com'];
  const aiLeadsMap = new Map();
  aiLeadsMap.set('sergio.prado@me.com', { id: 'ai-lead-1', name: 'Sergio Prado' });

  console.log('📋 Configuración:');
  console.log(`  - Aliases: [${normalizedAliases.join(', ')}]`);
  console.log(`  - AI Leads: [${Array.from(aiLeadsMap.keys()).join(', ')}]`);
  console.log('');

  console.log('📧 Emails de prueba:');
  testEmails.forEach((email, index) => {
    console.log(`  ${index + 1}. ${email.name}: ${email.from} → ${email.to}`);
  });
  console.log('');

  try {
    let includedCount = 0;
    let filteredCount = 0;

    for (let i = 0; i < testEmails.length; i++) {
      const testEmail = testEmails[i];
      console.log(`\n🔍 TEST ${i + 1}: ${testEmail.name}`);
      console.log('=' .repeat(50));
      
      const result = simulateCorrectedAliasFilter(testEmail, testEmail.to, normalizedAliases, aiLeadsMap);
      
      if (result.included) {
        includedCount++;
        console.log(`✅ RESULTADO: INCLUIDO (${result.reason})`);
      } else {
        filteredCount++;
        console.log(`❌ RESULTADO: FILTRADO (${result.reason})`);
      }
    }

    console.log('\n🔍 VERIFICACIÓN DE RESULTADOS:');
    console.log(`   - Emails incluidos: ${includedCount}`);
    console.log(`   - Emails filtrados: ${filteredCount}`);
    console.log(`   - Total: ${testEmails.length}`);
    
    // Verificar que los emails correctos fueron incluidos
    const expectedIncluded = testEmails.filter(email => 
      normalizedAliases.includes(email.to) || aiLeadsMap.has(email.from.toLowerCase())
    ).length;
    
    if (includedCount === expectedIncluded) {
      console.log('✅ FILTRO DE ALIAS FUNCIONANDO CORRECTAMENTE');
    } else {
      console.log('❌ FILTRO DE ALIAS NO FUNCIONA CORRECTAMENTE');
      console.log(`   Esperado: ${expectedIncluded} emails incluidos`);
      console.log(`   Obtenido: ${includedCount} emails incluidos`);
    }

    console.log('\n📊 RESUMEN:');
    console.log(`   - Emails a alias incluidos: ${includedCount}`);
    console.log(`   - Emails filtrados: ${filteredCount}`);
    console.log(`   - Corrección del filtro: ${includedCount === expectedIncluded ? '✅' : '❌'}`);

  } catch (error) {
    console.error('❌ Error durante la prueba:', error);
  }
}

// Ejecutar test
testAliasFilterFix().catch(console.error);
