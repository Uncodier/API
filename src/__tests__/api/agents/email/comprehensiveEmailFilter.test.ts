/**
 * Test para verificar el filtrado comprehensivo de emails con aliases reales
 * Específicamente para el caso: cleqos@gmail.com -> hola@uncodie.com
 */

// Función simplificada que replica la lógica de alias del filtro comprehensivo
function validateEmailByAliases(email: any, normalizedAliases: string[]): boolean {
  if (!normalizedAliases || normalizedAliases.length === 0) {
    return true; // Si no hay aliases configurados, permitir todos
  }

  const emailTo = (email.to || '').toLowerCase().trim();
  
  // Obtener campos de destino del email
  const destinationFields = [
    emailTo,
    email.headers?.['delivered-to']?.toLowerCase?.().trim?.() || '',
    email.headers?.['x-original-to']?.toLowerCase?.().trim?.() || '',
    email.headers?.['x-envelope-to']?.toLowerCase?.().trim?.() || '',
    email.headers?.['x-rcpt-to']?.toLowerCase?.().trim?.() || '',
    email.headers?.['envelope-to']?.toLowerCase?.().trim?.() || ''
  ];

  // Verificar si algún alias coincide
  return normalizedAliases.some(alias => {
    const normalizedAlias = alias.toLowerCase().trim();
    
    return destinationFields.some(destinationField => {
      // Coincidencia directa
      if (destinationField === normalizedAlias || destinationField.includes(normalizedAlias)) {
        return true;
      }
      
      // Verificar formato <email>
      const emailMatches = destinationField.match(/<([^>]+)>/g);
      if (emailMatches) {
        const matchResult = emailMatches.some((match: string) => {
          const extractedEmail = match.replace(/[<>]/g, '').trim();
          return extractedEmail === normalizedAlias;
        });
        if (matchResult) return true;
      }
      
      // Verificar lista separada por comas
      if (destinationField.includes(',')) {
        const emailList = destinationField.split(',').map((e: string) => e.trim());
        const listMatchResult = emailList.some((singleEmail: string) => {
          const cleanEmail = singleEmail.replace(/.*<([^>]+)>.*/, '$1').trim();
          return cleanEmail === normalizedAlias || singleEmail === normalizedAlias;
        });
        if (listMatchResult) return true;
      }
      
          return false;
    });
  });
}

describe('Comprehensive Email Filter - Alias Validation Logic', () => {
  
  beforeEach(() => {
    jest.clearAllMocks();
    // Mock console.log para evitar ruido
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should ACCEPT email from cleqos@gmail.com to hola@uncodie.com when hola@uncodie.com is configured as alias', () => {
    // Email de ejemplo: cleqos@gmail.com -> hola@uncodie.com
    const testEmail = {
      id: 'test-email-1',
      to: 'hola@uncodie.com',
      from: 'cleqos@gmail.com',
      subject: 'Consulta sobre servicios de desarrollo',
      body: 'Hola, me gustaría conocer más sobre sus servicios de desarrollo de software.',
      date: new Date().toISOString(),
      headers: {
        'message-id': '<test123@gmail.com>',
        'delivered-to': 'hola@uncodie.com'
      }
    };

    // Aliases configurados incluyen hola@uncodie.com
    const aliases = ['hola@uncodie.com', 'support@uncodie.com', 'info@uncodie.com'];

    // Ejecutar la validación
    const isValid = validateEmailByAliases(testEmail, aliases);

    // El email DEBE ser aceptado (NO filtrado)
    expect(isValid).toBe(true);
    
    console.log('✅ Test passed: Email from cleqos@gmail.com to hola@uncodie.com was ACCEPTED');
  });

  it('should REJECT email when TO address is NOT in aliases', () => {
    // Email a una dirección que NO está en aliases
    const testEmail = {
      id: 'test-email-2',
      to: 'otro@uncodie.com', // Esta dirección NO está en aliases
      from: 'cleqos@gmail.com',
      subject: 'Email a dirección no configurada',
      body: 'Este email debería ser filtrado.',
      date: new Date().toISOString(),
      headers: {
        'message-id': '<test456@gmail.com>'
      }
    };

    // Aliases SOLO incluyen hola@uncodie.com (NO incluye otro@uncodie.com)
    const aliases = ['hola@uncodie.com'];

    // Ejecutar la validación
    const isValid = validateEmailByAliases(testEmail, aliases);

    // El email DEBE ser rechazado (filtrado)
    expect(isValid).toBe(false);
    
    console.log('✅ Test passed: Email to non-alias address was correctly REJECTED');
  });

  it('should handle multiple emails with mixed alias matches', () => {
    const testEmails = [
      {
        id: 'email-1',
        to: 'hola@uncodie.com', // SÍ está en aliases
        from: 'cleqos@gmail.com',
        subject: 'Email válido 1',
        body: 'Este debería pasar.',
        headers: { 'message-id': '<test1@gmail.com>' }
      },
      {
        id: 'email-2',
        to: 'support@uncodie.com', // SÍ está en aliases
        from: 'usuario@example.com',
        subject: 'Email válido 2',
        body: 'Este también debería pasar.',
        headers: { 'message-id': '<test2@example.com>' }
      },
      {
        id: 'email-3',
        to: 'ventas@uncodie.com', // NO está en aliases
        from: 'cliente@test.com',
        subject: 'Email inválido',
        body: 'Este debería ser filtrado.',
        headers: { 'message-id': '<test3@test.com>' }
      }
    ];

    const aliases = ['hola@uncodie.com', 'support@uncodie.com']; // NO incluye ventas@uncodie.com

    // Verificar cada email individualmente
    const results = testEmails.map(email => ({
      email,
      isValid: validateEmailByAliases(email, aliases)
    }));

    // Deben pasar 2 emails (los que coinciden con aliases)
    const validEmails = results.filter(r => r.isValid);
    const rejectedEmails = results.filter(r => !r.isValid);

    expect(validEmails).toHaveLength(2);
    expect(rejectedEmails).toHaveLength(1);

    // Verificar que los emails correctos pasaron
    expect(validEmails.find(r => r.email.to === 'hola@uncodie.com')).toBeDefined();
    expect(validEmails.find(r => r.email.to === 'support@uncodie.com')).toBeDefined();
    expect(rejectedEmails.find(r => r.email.to === 'ventas@uncodie.com')).toBeDefined();

    console.log('✅ Test passed: Mixed alias filtering worked correctly');
  });

  it('should handle hola@uncodie.com in complex email formats', () => {
    const testEmails = [
      {
        id: 'complex-1',
        to: 'Equipo Uncodie <hola@uncodie.com>', // Formato con nombre
        from: 'cleqos@gmail.com',
        subject: 'Email con formato complejo 1',
        body: 'Test con nombre en TO.',
        headers: { 'message-id': '<complex1@gmail.com>' }
      },
      {
        id: 'complex-2',
        to: 'info@client.com, hola@uncodie.com', // Múltiples destinatarios
        from: 'cleqos@gmail.com',
        subject: 'Email con formato complejo 2',
        body: 'Test con múltiples destinatarios.',
        headers: { 
          'message-id': '<complex2@gmail.com>',
          'delivered-to': 'hola@uncodie.com'
        }
      },
      {
        id: 'complex-3',
        to: 'HOLA@UNCODIE.COM', // Mayúsculas
        from: 'cleqos@gmail.com',
        subject: 'Email con formato complejo 3',
        body: 'Test con mayúsculas.',
        headers: { 'message-id': '<complex3@gmail.com>' }
      }
    ];

    const aliases = ['hola@uncodie.com'];

    // Verificar cada email individualmente
    const results = testEmails.map(email => ({
      email,
      isValid: validateEmailByAliases(email, aliases)
    }));

    // Todos los emails deben pasar (contienen hola@uncodie.com en algún formato)
    const validEmails = results.filter(r => r.isValid);
    expect(validEmails).toHaveLength(3);

    // Verificar específicamente cada formato
    expect(results[0].isValid).toBe(true); // Formato con nombre
    expect(results[1].isValid).toBe(true); // Múltiples destinatarios
    expect(results[2].isValid).toBe(true); // Mayúsculas

    console.log('✅ Test passed: Complex email formats handled correctly');
  });

  it('should verify the EXACT case: cleqos@gmail.com to hola@uncodie.com', () => {
    // Test específico del caso reportado por el usuario
    const exactTestEmail = {
      to: 'hola@uncodie.com',
      from: 'cleqos@gmail.com',
      subject: 'Test del caso específico',
      body: 'Este es el test del caso exacto reportado.',
      headers: {
        'message-id': '<exact-test@gmail.com>',
        'delivered-to': 'hola@uncodie.com'
      }
    };

    // hola@uncodie.com debe estar en settings.channels.email.aliases
    const configuredAliases = ['hola@uncodie.com'];

    // Ejecutar validación
    const shouldBeAccepted = validateEmailByAliases(exactTestEmail, configuredAliases);

    // VERIFICACIÓN CRÍTICA: Este email NO debe ser filtrado
    expect(shouldBeAccepted).toBe(true);

    console.log('🎯 CRITICAL TEST PASSED: cleqos@gmail.com -> hola@uncodie.com was ACCEPTED (not filtered)');
    console.log('📧 This email SHOULD be responded to by the system');
  });
}); 