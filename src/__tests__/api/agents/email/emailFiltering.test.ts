/**
 * Test para la funcionalidad de filtrado de emails por aliases
 */

// Mock de la función filterEmailsByAliases extraída del código principal
function filterEmailsByAliases(emails: any[], aliases: string[]): any[] {
  if (!aliases || aliases.length === 0) {
    console.log('[EMAIL_API] 📧 No se especificaron aliases, procesando todos los emails');
    return emails;
  }

  console.log(`[EMAIL_API] 🔍 Filtrando emails según aliases configurados: ${aliases.join(', ')}`);
  
  const filteredEmails = emails.filter(email => {
    const emailTo = (email.to || '').toLowerCase().trim();
    
    // Verificar si algún alias coincide con el campo "to" del email
    const isValidEmail = aliases.some(alias => {
      const normalizedAlias = alias.toLowerCase().trim();
      
      // Verificar coincidencia exacta
      if (emailTo === normalizedAlias) {
        return true;
      }
      
      // Verificar si el alias está incluido en el campo "to"
      if (emailTo.includes(normalizedAlias)) {
        return true;
      }
      
      // Verificar coincidencia en formato "Name <email@domain.com>" o similar
      const emailMatches = emailTo.match(/<([^>]+)>/g);
      if (emailMatches) {
        return emailMatches.some((match: string) => {
          const extractedEmail = match.replace(/[<>]/g, '').trim();
          return extractedEmail === normalizedAlias;
        });
      }
      
      // Verificar si hay múltiples emails separados por coma
      const emailList = emailTo.split(',').map((e: string) => e.trim());
      return emailList.some((singleEmail: string) => {
        const cleanEmail = singleEmail.replace(/.*<([^>]+)>.*/, '$1').trim();
        return cleanEmail === normalizedAlias || singleEmail === normalizedAlias;
      });
    });

    if (isValidEmail) {
      console.log(`[EMAIL_API] ✅ Email incluido - To: ${email.to} (coincide con aliases)`);
    } else {
      console.log(`[EMAIL_API] ❌ Email excluido - To: ${email.to} (no coincide con aliases: ${aliases.join(', ')})`);
    }

    return isValidEmail;
  });

  console.log(`[EMAIL_API] 📊 Filtrado completado: ${filteredEmails.length}/${emails.length} emails incluidos`);
  return filteredEmails;
}

describe('Email Filtering by Aliases', () => {
  
  // Mock console.log para evitar ruido en los tests
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('filterEmailsByAliases', () => {
    const mockEmails = [
      { to: 'support@example.com', subject: 'Need help', from: 'customer@test.com' },
      { to: 'info@example.com', subject: 'Information request', from: 'user@test.com' },
      { to: 'sales@example.com', subject: 'Sales inquiry', from: 'lead@test.com' },
      { to: 'contact@example.com', subject: 'General contact', from: 'visitor@test.com' },
      { to: 'John Doe <support@example.com>', subject: 'Support request with name', from: 'client@test.com' },
      { to: 'marketing@example.com, sales@example.com', subject: 'Multi-recipient', from: 'partner@test.com' },
      { to: 'SUPPORT@EXAMPLE.COM', subject: 'Uppercase email', from: 'uppercase@test.com' }
    ];

    it('should return all emails when no aliases are configured', () => {
      const result = filterEmailsByAliases(mockEmails, []);
      expect(result).toHaveLength(mockEmails.length);
      expect(result).toEqual(mockEmails);
    });

    it('should return all emails when aliases is null', () => {
      const result = filterEmailsByAliases(mockEmails, null as any);
      expect(result).toHaveLength(mockEmails.length);
      expect(result).toEqual(mockEmails);
    });

    it('should filter emails by single alias', () => {
      const aliases = ['support@example.com'];
      const result = filterEmailsByAliases(mockEmails, aliases);
      
      expect(result).toHaveLength(3); // Includes normal, with name, and uppercase
      expect(result.map(e => e.subject)).toEqual([
        'Need help',
        'Support request with name', 
        'Uppercase email'
      ]);
    });

    it('should filter emails by multiple aliases', () => {
      const aliases = ['support@example.com', 'info@example.com'];
      const result = filterEmailsByAliases(mockEmails, aliases);
      
      expect(result).toHaveLength(4); // support + info + support with name + uppercase support
      expect(result.map(e => e.subject)).toEqual([
        'Need help',
        'Information request',
        'Support request with name',
        'Uppercase email'
      ]);
    });

    it('should handle emails with names in format "Name <email>"', () => {
      const aliases = ['support@example.com'];
      const emailWithName = [
        { to: 'John Doe <support@example.com>', subject: 'Test', from: 'test@test.com' }
      ];
      
      const result = filterEmailsByAliases(emailWithName, aliases);
      expect(result).toHaveLength(1);
      expect(result[0].subject).toBe('Test');
    });

    it('should handle multiple recipients separated by comma', () => {
      const aliases = ['sales@example.com'];
      const multiRecipientEmail = [
        { to: 'marketing@example.com, sales@example.com', subject: 'Multi', from: 'test@test.com' }
      ];
      
      const result = filterEmailsByAliases(multiRecipientEmail, aliases);
      expect(result).toHaveLength(1);
      expect(result[0].subject).toBe('Multi');
    });

    it('should be case insensitive', () => {
      const aliases = ['support@example.com'];
      const uppercaseEmail = [
        { to: 'SUPPORT@EXAMPLE.COM', subject: 'Uppercase', from: 'test@test.com' }
      ];
      
      const result = filterEmailsByAliases(uppercaseEmail, aliases);
      expect(result).toHaveLength(1);
      expect(result[0].subject).toBe('Uppercase');
    });

    it('should exclude emails not matching any alias', () => {
      const aliases = ['allowed@example.com'];
      const result = filterEmailsByAliases(mockEmails, aliases);
      
      expect(result).toHaveLength(0);
    });

    it('should handle empty email "to" field', () => {
      const emailsWithEmpty = [
        { to: '', subject: 'Empty to', from: 'test@test.com' },
        { to: null, subject: 'Null to', from: 'test@test.com' },
        { to: undefined, subject: 'Undefined to', from: 'test@test.com' },
        { to: 'support@example.com', subject: 'Valid to', from: 'test@test.com' }
      ];
      
      const aliases = ['support@example.com'];
      const result = filterEmailsByAliases(emailsWithEmpty, aliases);
      
      expect(result).toHaveLength(1);
      expect(result[0].subject).toBe('Valid to');
    });

    it('should handle complex email formats', () => {
      const complexEmails = [
        { to: '"John Doe" <support@example.com>', subject: 'Quoted name', from: 'test@test.com' },
        { to: 'support@example.com (Support Team)', subject: 'With parentheses', from: 'test@test.com' },
        { to: '  support@example.com  ', subject: 'With spaces', from: 'test@test.com' }
      ];
      
      const aliases = ['support@example.com'];
      const result = filterEmailsByAliases(complexEmails, aliases);
      
      expect(result).toHaveLength(3);
      expect(result.map(e => e.subject)).toEqual([
        'Quoted name',
        'With parentheses', 
        'With spaces'
      ]);
    });

    it('should NOT filter email from cleqos@gmail.com to hola@uncodie.com when hola@uncodie.com is in aliases', () => {
      // Test específico para verificar que emails a hola@uncodie.com se respondan
      const emailFromCleqos = [
        { 
          to: 'hola@uncodie.com', 
          subject: 'Consulta sobre servicios', 
          from: 'cleqos@gmail.com',
          body: 'Hola, me gustaría conocer más sobre sus servicios.'
        }
      ];
      
      // hola@uncodie.com debe estar configurado como alias
      const aliases = ['hola@uncodie.com'];
      const result = filterEmailsByAliases(emailFromCleqos, aliases);
      
      // El email NO debe ser filtrado (debe incluirse para respuesta)
      expect(result).toHaveLength(1);
      expect(result[0].from).toBe('cleqos@gmail.com');
      expect(result[0].to).toBe('hola@uncodie.com');
      expect(result[0].subject).toBe('Consulta sobre servicios');
    });

    it('should handle hola@uncodie.com with different capitalizations', () => {
      const emailVariations = [
        { to: 'hola@uncodie.com', subject: 'Lowercase', from: 'cleqos@gmail.com' },
        { to: 'HOLA@UNCODIE.COM', subject: 'Uppercase', from: 'cleqos@gmail.com' },
        { to: 'Hola@Uncodie.Com', subject: 'Mixed case', from: 'cleqos@gmail.com' },
        { to: '  hola@uncodie.com  ', subject: 'With spaces', from: 'cleqos@gmail.com' }
      ];
      
      const aliases = ['hola@uncodie.com'];
      const result = filterEmailsByAliases(emailVariations, aliases);
      
      // Todos los emails deben pasar el filtro
      expect(result).toHaveLength(4);
      expect(result.map(e => e.subject)).toEqual([
        'Lowercase',
        'Uppercase',
        'Mixed case',
        'With spaces'
      ]);
    });

    it('should handle hola@uncodie.com in complex formats', () => {
      const complexFormats = [
        { to: 'Equipo Uncodie <hola@uncodie.com>', subject: 'With name', from: 'cleqos@gmail.com' },
        { to: 'info@client.com, hola@uncodie.com', subject: 'Multiple recipients', from: 'cleqos@gmail.com' },
        { to: '"Soporte Uncodie" <hola@uncodie.com>', subject: 'Quoted name', from: 'cleqos@gmail.com' }
      ];
      
      const aliases = ['hola@uncodie.com'];
      const result = filterEmailsByAliases(complexFormats, aliases);
      
      // Todos deben pasar el filtro ya que contienen hola@uncodie.com
      expect(result).toHaveLength(3);
      expect(result.map(e => e.subject)).toEqual([
        'With name',
        'Multiple recipients',
        'Quoted name'
      ]);
    });
  });
}); 