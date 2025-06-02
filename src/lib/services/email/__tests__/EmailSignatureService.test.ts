import { EmailSignatureService, SignatureData } from '../EmailSignatureService';
import { supabaseAdmin } from '@/lib/database/supabase-client';

// Mock de supabase
jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        eq: jest.fn(() => ({
          single: jest.fn()
        }))
      }))
    }))
  }
}));

describe('EmailSignatureService', () => {
  const mockSiteId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
  
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('generateAgentSignature', () => {
    it('debería generar una firma básica cuando no hay datos del sitio', async () => {
      // Mock de respuestas vacías
      const mockFrom = jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            single: jest.fn().mockResolvedValue({ data: null, error: null })
          })
        })
      });
      
      (supabaseAdmin.from as jest.Mock).mockReturnValue({
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            single: jest.fn().mockResolvedValue({ data: null, error: null })
          })
        })
      });

      const result = await EmailSignatureService.generateAgentSignature(mockSiteId);

      expect(result).toHaveProperty('plainText');
      expect(result).toHaveProperty('formatted');
      expect(result.plainText).toContain('Equipo de Atención al Cliente');
      expect(result.formatted).toContain('Equipo de Atención al Cliente');
    });

    it('debería generar una firma personalizada con nombre de agente', async () => {
      // Mock de respuestas vacías
      (supabaseAdmin.from as jest.Mock).mockReturnValue({
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            single: jest.fn().mockResolvedValue({ data: null, error: null })
          })
        })
      });

      const agentName = 'María González';
      const result = await EmailSignatureService.generateAgentSignature(mockSiteId, agentName);

      expect(result.plainText).toContain(agentName);
      expect(result.formatted).toContain(agentName);
    });

    it('debería generar una firma completa con datos del sitio y settings', async () => {
      const mockSiteData = {
        name: 'TechCorp Solutions',
        url: 'https://techcorp.com',
        description: 'Soluciones tecnológicas innovadoras',
        logo_url: 'https://techcorp.com/logo.png'
      };

      const mockSettingsData = {
        company_size: 'Medium',
        industry: 'Technology',
        about: 'Empresa líder en desarrollo de software',
        team_members: JSON.stringify([
          { name: 'Juan Pérez', role: 'CEO', phone: '+34 123 456 789' },
          { name: 'Ana García', role: 'CTO', email: 'ana@techcorp.com' }
        ]),
        locations: JSON.stringify([
          { address: 'Calle Principal 123, Madrid, España', phone: '+34 987 654 321', type: 'headquarters' }
        ]),
        social_media: JSON.stringify({
          linkedin: 'https://linkedin.com/company/techcorp',
          twitter: 'https://twitter.com/techcorp'
        }),
        channels: {
          email: {
            email: 'info@techcorp.com'
          }
        }
      };

      // Mock para tabla sites
      const mockSitesQuery = {
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            single: jest.fn().mockResolvedValue({ data: mockSiteData, error: null })
          })
        })
      };

      // Mock para tabla settings
      const mockSettingsQuery = {
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            single: jest.fn().mockResolvedValue({ data: mockSettingsData, error: null })
          })
        })
      };

      (supabaseAdmin.from as jest.Mock)
        .mockReturnValueOnce(mockSitesQuery)
        .mockReturnValueOnce(mockSettingsQuery);

      const result = await EmailSignatureService.generateAgentSignature(mockSiteId, 'María González');

      expect(result.plainText).toContain('María González');
      expect(result.plainText).toContain('TechCorp Solutions');
      expect(result.plainText).toContain('info@techcorp.com');
      expect(result.plainText).toContain('+34 987 654 321');
      expect(result.plainText).toContain('https://techcorp.com');
      expect(result.plainText).toContain('"Empresa líder en desarrollo de software"');
      
      expect(result.formatted).toContain('<table');
      expect(result.formatted).toContain('María González');
      expect(result.formatted).toContain('TechCorp Solutions');
      expect(result.formatted).toContain('https://techcorp.com/logo.png');
      expect(result.formatted).toContain('Empresa líder en desarrollo de software');
    });

    it('debería manejar campos JSON como strings', async () => {
      const mockSettingsData = {
        team_members: '[{"name":"Test User","role":"Manager","phone":"+123456789"}]',
        locations: '[{"address":"Test Address","phone":"+987654321"}]',
        social_media: '{"linkedin":"https://linkedin.com/test"}'
      };

      (supabaseAdmin.from as jest.Mock)
        .mockReturnValueOnce({
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              single: jest.fn().mockResolvedValue({ data: null, error: null })
            })
          })
        })
        .mockReturnValueOnce({
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              single: jest.fn().mockResolvedValue({ data: mockSettingsData, error: null })
            })
          })
        });

      const result = await EmailSignatureService.generateAgentSignature(mockSiteId);

      // Se debe priorizar el teléfono de ubicaciones (+987654321) sobre el de miembros del equipo
      expect(result.plainText).toContain('+987654321');
    });

    it('debería generar una firma completa con datos del sitio y settings', async () => {
      const mockSiteData = {
        name: 'TechCorp Solutions',
        url: 'https://techcorp.com',
        description: 'Soluciones tecnológicas innovadoras',
        logo_url: 'https://techcorp.com/logo.png'
      };

      const mockSettingsData = {
        company_size: 'Medium',
        industry: 'Technology',
        about: 'Empresa líder en desarrollo de software',
        team_members: JSON.stringify([
          { name: 'Juan Pérez', role: 'CEO', phone: '+34 123 456 789' },
          { name: 'Ana García', role: 'CTO', email: 'ana@techcorp.com' }
        ]),
        locations: JSON.stringify([
          { address: 'Calle Principal 123, Madrid, España', phone: '+34 987 654 321', type: 'headquarters' }
        ]),
        social_media: JSON.stringify({
          linkedin: 'https://linkedin.com/company/techcorp',
          twitter: 'https://twitter.com/techcorp'
        }),
        channels: {
          email: {
            email: 'info@techcorp.com'
          }
        }
      };

      // Mock para tabla sites
      const mockSitesQuery = {
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            single: jest.fn().mockResolvedValue({ data: mockSiteData, error: null })
          })
        })
      };

      // Mock para tabla settings
      const mockSettingsQuery = {
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            single: jest.fn().mockResolvedValue({ data: mockSettingsData, error: null })
          })
        })
      };

      (supabaseAdmin.from as jest.Mock)
        .mockReturnValueOnce(mockSitesQuery)
        .mockReturnValueOnce(mockSettingsQuery);

      const result = await EmailSignatureService.generateAgentSignature(mockSiteId, 'María González');

      expect(result.plainText).toContain('María González');
      expect(result.plainText).toContain('TechCorp Solutions');
      expect(result.plainText).toContain('info@techcorp.com');
      expect(result.plainText).toContain('+34 987 654 321');
      expect(result.plainText).toContain('https://techcorp.com');
      expect(result.plainText).toContain('"Empresa líder en desarrollo de software"');
      
      expect(result.formatted).toContain('<table');
      expect(result.formatted).toContain('María González');
      expect(result.formatted).toContain('TechCorp Solutions');
      expect(result.formatted).toContain('https://techcorp.com/logo.png');
      expect(result.formatted).toContain('Empresa líder en desarrollo de software');
    });

    it('debería manejar errores de parsing JSON gracefully', async () => {
      const mockSettingsData = {
        team_members: 'invalid json',
        locations: '{invalid json}',
        social_media: 'not json at all'
      };

      (supabaseAdmin.from as jest.Mock)
        .mockReturnValueOnce({
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              single: jest.fn().mockResolvedValue({ data: null, error: null })
            })
          })
        })
        .mockReturnValueOnce({
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              single: jest.fn().mockResolvedValue({ data: mockSettingsData, error: null })
            })
          })
        });

      const result = await EmailSignatureService.generateAgentSignature(mockSiteId);

      expect(result).toHaveProperty('plainText');
      expect(result).toHaveProperty('formatted');
      // Debería generar una firma básica sin fallar
      expect(result.plainText).toContain('Equipo de Atención al Cliente');
    });

    it('debería priorizar teléfono de ubicaciones sobre miembros del equipo', async () => {
      const mockSettingsData = {
        team_members: JSON.stringify([
          { name: 'Team Member', phone: '+111111111' }
        ]),
        locations: JSON.stringify([
          { address: 'Main Office', phone: '+222222222' }
        ])
      };

      (supabaseAdmin.from as jest.Mock)
        .mockReturnValueOnce({
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              single: jest.fn().mockResolvedValue({ data: null, error: null })
            })
          })
        })
        .mockReturnValueOnce({
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              single: jest.fn().mockResolvedValue({ data: mockSettingsData, error: null })
            })
          })
        });

      const result = await EmailSignatureService.generateAgentSignature(mockSiteId);

      expect(result.plainText).toContain('+222222222');
      expect(result.plainText).not.toContain('+111111111');
    });

    it('debería seleccionar ubicación principal cuando hay múltiples ubicaciones', async () => {
      const mockSettingsData = {
        locations: JSON.stringify([
          { address: 'Branch Office', phone: '+111111111' },
          { address: 'Headquarters', phone: '+222222222', type: 'headquarters' },
          { address: 'Another Branch', phone: '+333333333' }
        ])
      };

      (supabaseAdmin.from as jest.Mock)
        .mockReturnValueOnce({
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              single: jest.fn().mockResolvedValue({ data: null, error: null })
            })
          })
        })
        .mockReturnValueOnce({
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              single: jest.fn().mockResolvedValue({ data: mockSettingsData, error: null })
            })
          })
        });

      const result = await EmailSignatureService.generateAgentSignature(mockSiteId);

      expect(result.plainText).toContain('+222222222');
    });

    it('debería incluir descripción corta en firma formateada', async () => {
      const mockSiteData = {
        name: 'Test Company',
        description: 'Una empresa de prueba'
      };

      (supabaseAdmin.from as jest.Mock)
        .mockReturnValueOnce({
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              single: jest.fn().mockResolvedValue({ data: mockSiteData, error: null })
            })
          })
        })
        .mockReturnValueOnce({
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              single: jest.fn().mockResolvedValue({ data: null, error: null })
            })
          })
        });

      const result = await EmailSignatureService.generateAgentSignature(mockSiteId);

      expect(result.formatted).toContain('Test Company');
      expect(result.formatted).toContain("\"Una empresa de prueba\""); // Ahora SÍ incluimos descripción corta
      expect(result.plainText).toContain("\"Una empresa de prueba\"");
    });

    it('debería omitir descripción muy larga en firma formateada', async () => {
      const longDescription = 'Esta es una descripción muy larga que supera los 200 caracteres permitidos para la firma como tweet pitch y por lo tanto debería ser omitida en la versión formateada de la firma del agente porque es demasiado extensa para ser mostrada como tweet pitch.';
      
      const mockSiteData = {
        name: 'Test Company',
        description: longDescription
      };

      (supabaseAdmin.from as jest.Mock)
        .mockReturnValueOnce({
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              single: jest.fn().mockResolvedValue({ data: mockSiteData, error: null })
            })
          })
        })
        .mockReturnValueOnce({
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              single: jest.fn().mockResolvedValue({ data: null, error: null })
            })
          })
        });

      const result = await EmailSignatureService.generateAgentSignature(mockSiteId);

      expect(result.formatted).not.toContain(longDescription);
      expect(result.formatted).toContain('Test Company');
    });

    it('debería generar firma limpia sin descripción larga', async () => {
      const longDescription = 'Esta es una descripción muy larga que supera los 200 caracteres permitidos para la firma como tweet pitch y por lo tanto debería ser omitida en la versión formateada de la firma del agente porque es demasiado extensa para ser mostrada como tweet pitch.';
      
      const mockSiteData = {
        name: 'Test Company',
        description: longDescription
      };

      (supabaseAdmin.from as jest.Mock)
        .mockReturnValueOnce({
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              single: jest.fn().mockResolvedValue({ data: mockSiteData, error: null })
            })
          })
        })
        .mockReturnValueOnce({
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              single: jest.fn().mockResolvedValue({ data: null, error: null })
            })
          })
        });

      const result = await EmailSignatureService.generateAgentSignature(mockSiteId);

      expect(result.formatted).not.toContain(longDescription);
      expect(result.formatted).toContain('Test Company');
    });

    it('debería manejar errores de base de datos y devolver firma básica', async () => {
      (supabaseAdmin.from as jest.Mock).mockReturnValue({
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            single: jest.fn().mockRejectedValue(new Error('Database error'))
          })
        })
      });

      const result = await EmailSignatureService.generateAgentSignature(mockSiteId, 'Test Agent');

      expect(result).toHaveProperty('plainText');
      expect(result).toHaveProperty('formatted');
      expect(result.plainText).toContain('Test Agent');
    });
  });
}); 