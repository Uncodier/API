import { AgentService } from '../AgentService';
import { supabaseAdmin } from '@/lib/database/supabase-client';

// Mock de supabaseAdmin
jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    single: jest.fn().mockImplementation(() => Promise.resolve({
      data: null,
      error: null
    })),
    storage: {
      from: jest.fn().mockReturnThis(),
      download: jest.fn().mockImplementation(() => Promise.resolve({
        data: null,
        error: null
      })),
      getPublicUrl: jest.fn().mockReturnThis(),
    }
  }
}));

describe('AgentService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // Test para getSiteById
  describe('getSiteById', () => {
    it('debe retornar null cuando el ID no es un UUID válido', async () => {
      const result = await AgentService.getSiteById('invalid-uuid');
      expect(result).toBeNull();
    });

    it('debe retornar null cuando la consulta a la base de datos devuelve un error', async () => {
      // Configurar el mock para que devuelva un error
      (supabaseAdmin.from('sites').select('*').eq('id', 'valid-uuid').single as jest.Mock).mockResolvedValueOnce({
        data: null,
        error: new Error('Error de base de datos')
      });

      const result = await AgentService.getSiteById('valid-uuid');
      expect(result).toBeNull();
    });

    it('debe retornar los datos del sitio cuando la consulta es exitosa', async () => {
      const mockSiteData = {
        id: 'valid-uuid',
        name: 'Test Site',
        url: 'https://test-site.com',
        description: 'Test site description',
        resource_urls: JSON.stringify({ blog: 'https://test-site.com/blog' }),
        competitors: JSON.stringify(['competitor1', 'competitor2']),
        tracking: JSON.stringify({ ga: 'UA-12345678' })
      };

      // Configurar el mock para que devuelva datos
      (supabaseAdmin.from('sites').select('*').eq('id', 'valid-uuid').single as jest.Mock).mockResolvedValueOnce({
        data: mockSiteData,
        error: null
      });

      const result = await AgentService.getSiteById('valid-uuid');
      
      expect(result).not.toBeNull();
      expect(result.name).toBe('Test Site');
      expect(result.url).toBe('https://test-site.com');
      // Verificar que los campos JSON se hayan parseado
      expect(result.resource_urls).toEqual({ blog: 'https://test-site.com/blog' });
      expect(result.competitors).toEqual(['competitor1', 'competitor2']);
      expect(result.tracking).toEqual({ ga: 'UA-12345678' });
    });
  });

  // Test para getSiteSettingsById
  describe('getSiteSettingsById', () => {
    it('debe retornar null cuando el ID no es un UUID válido', async () => {
      const result = await AgentService.getSiteSettingsById('invalid-uuid');
      expect(result).toBeNull();
    });

    it('debe retornar null cuando la consulta a la base de datos devuelve un error', async () => {
      // Configurar el mock para que devuelva un error
      (supabaseAdmin.from('site_settings').select('*').eq('site_id', 'valid-uuid').single as jest.Mock).mockResolvedValueOnce({
        data: null,
        error: new Error('Error de base de datos')
      });

      const result = await AgentService.getSiteSettingsById('valid-uuid');
      expect(result).toBeNull();
    });

    it('debe retornar los datos de la configuración cuando la consulta es exitosa', async () => {
      const mockSettingsData = {
        id: 'settings-uuid',
        site_id: 'valid-uuid',
        about: 'About the company',
        company_size: 'Medium',
        industry: 'Technology',
        products: JSON.stringify(['product1', 'product2']),
        services: JSON.stringify(['service1', 'service2']),
        swot: JSON.stringify({
          strengths: ['strength1'],
          weaknesses: ['weakness1'],
          opportunities: ['opportunity1'],
          threats: ['threat1']
        }),
        team_members: JSON.stringify([
          { name: 'John Doe', role: 'CEO' },
          { name: 'Jane Smith', role: 'CTO' }
        ])
      };

      // Configurar el mock para que devuelva datos
      (supabaseAdmin.from('site_settings').select('*').eq('site_id', 'valid-uuid').single as jest.Mock).mockResolvedValueOnce({
        data: mockSettingsData,
        error: null
      });

      const result = await AgentService.getSiteSettingsById('valid-uuid');
      
      expect(result).not.toBeNull();
      expect(result.about).toBe('About the company');
      expect(result.company_size).toBe('Medium');
      expect(result.industry).toBe('Technology');
      // Verificar que los campos JSON se hayan parseado
      expect(result.products).toEqual(['product1', 'product2']);
      expect(result.services).toEqual(['service1', 'service2']);
      expect(result.swot).toEqual({
        strengths: ['strength1'],
        weaknesses: ['weakness1'],
        opportunities: ['opportunity1'],
        threats: ['threat1']
      });
      expect(result.team_members).toEqual([
        { name: 'John Doe', role: 'CEO' },
        { name: 'Jane Smith', role: 'CTO' }
      ]);
    });
  });
}); 