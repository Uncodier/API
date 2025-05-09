import { DataFetcher } from '../DataFetcher';
import { AgentCacheService } from '../../AgentCacheService';
import { DatabaseAdapter } from '../../../../adapters/DatabaseAdapter';
import { Base } from '../../../../agents/Base';

// Mocks
jest.mock('../../AgentCacheService', () => ({
  AgentCacheService: {
    getInstance: jest.fn().mockReturnValue({
      getAgentData: jest.fn(),
      setAgentData: jest.fn()
    })
  }
}));

jest.mock('../../../../adapters/DatabaseAdapter', () => ({
  DatabaseAdapter: {
    isValidUUID: jest.fn().mockImplementation((uuid) => {
      return uuid === 'valid-uuid' || uuid === 'site-uuid';
    }),
    getAgentById: jest.fn(),
    getAgentFiles: jest.fn(),
    getSiteById: jest.fn(),
    getSiteSettingsById: jest.fn()
  }
}));

describe('DataFetcher', () => {
  let mockProcessor: Base;
  
  beforeEach(() => {
    jest.clearAllMocks();
    
    // Mock del procesador base
    mockProcessor = {
      getName: jest.fn().mockReturnValue('Test Agent'),
      getId: jest.fn().mockReturnValue('processor-id'),
      getCapabilities: jest.fn().mockReturnValue(['capability1', 'capability2'])
    } as unknown as Base;
  });
  
  describe('getAgentData', () => {
    it('debe retornar datos por defecto si el agentId no es válido', async () => {
      const result = await DataFetcher.getAgentData('invalid-uuid', mockProcessor);
      
      expect(result.name).toBe('Test Agent');
      expect(result.backstory).toBe('');
      expect(result.capabilities).toEqual([]);
    });
    
    it('debe obtener datos de caché si están disponibles', async () => {
      // Configurar el mock de caché para devolver datos
      const mockCacheData = {
        agentData: {
          name: 'Cached Agent',
          backstory: 'Cached backstory',
          prompt: 'Cached prompt',
          configuration: {
            description: 'Cached description'
          }
        }
      };
      
      (AgentCacheService.getInstance().getAgentData as jest.Mock).mockResolvedValueOnce(mockCacheData);
      
      const result = await DataFetcher.getAgentData('valid-uuid', mockProcessor);
      
      expect(result.name).toBe('Cached Agent');
      expect(result.backstory).toBe('Cached backstory');
      expect(result.agentPrompt).toBe('Cached prompt');
      expect(result.description).toBe('Cached description');
    });
    
    it('debe incorporar información del sitio y configuración en el backstory', async () => {
      // Mock de los datos del agente con site_id
      const mockAgentData = {
        id: 'valid-uuid',
        name: 'DB Agent',
        backstory: 'DB backstory',
        site_id: 'site-uuid'
      };
      
      // Mock de los datos del sitio
      const mockSiteData = {
        id: 'site-uuid',
        name: 'Test Site',
        url: 'https://test-site.com',
        description: 'Test site description',
        resource_urls: { blog: 'https://test-site.com/blog' },
        competitors: ['competitor1', 'competitor2']
      };
      
      // Mock de la configuración del sitio
      const mockSiteSettings = {
        site_id: 'site-uuid',
        about: 'About the test company',
        company_size: 'Medium',
        industry: 'Technology',
        products: ['product1', 'product2'],
        services: ['service1', 'service2'],
        swot: {
          strengths: ['strength1'],
          weaknesses: ['weakness1']
        }
      };
      
      // Configurar mocks
      (DatabaseAdapter.getAgentById as jest.Mock).mockResolvedValueOnce(mockAgentData);
      (DatabaseAdapter.getAgentFiles as jest.Mock).mockResolvedValueOnce([]);
      (DatabaseAdapter.getSiteById as jest.Mock).mockResolvedValueOnce(mockSiteData);
      (DatabaseAdapter.getSiteSettingsById as jest.Mock).mockResolvedValueOnce(mockSiteSettings);
      
      const result = await DataFetcher.getAgentData('valid-uuid', mockProcessor);
      
      // Verificar que el backstory incluya la información del sitio
      expect(result.backstory).toContain('DB backstory');
      expect(result.backstory).toContain('INFORMACIÓN DEL SITIO');
      expect(result.backstory).toContain('Test Site');
      expect(result.backstory).toContain('https://test-site.com');
      
      // Verificar que el backstory incluya la configuración del sitio
      expect(result.backstory).toContain('CONFIGURACIÓN DEL SITIO');
      expect(result.backstory).toContain('About the test company');
      expect(result.backstory).toContain('Technology');
      expect(result.backstory).toContain('product1');
      expect(result.backstory).toContain('service1');
      
      // Verificar que se haya llamado a setAgentData para guardar en caché
      expect(AgentCacheService.getInstance().setAgentData).toHaveBeenCalledWith('valid-uuid', expect.objectContaining({
        id: 'valid-uuid',
        site: mockSiteData,
        siteSettings: mockSiteSettings
      }));
    });
    
    it('debe manejar correctamente cuando solo hay información del sitio pero no configuración', async () => {
      // Mock de los datos del agente con site_id
      const mockAgentData = {
        id: 'valid-uuid',
        name: 'DB Agent',
        backstory: 'DB backstory',
        site_id: 'site-uuid'
      };
      
      // Mock de los datos del sitio
      const mockSiteData = {
        id: 'site-uuid',
        name: 'Test Site',
        url: 'https://test-site.com',
        description: 'Test site description'
      };
      
      // Configurar mocks
      (DatabaseAdapter.getAgentById as jest.Mock).mockResolvedValueOnce(mockAgentData);
      (DatabaseAdapter.getAgentFiles as jest.Mock).mockResolvedValueOnce([]);
      (DatabaseAdapter.getSiteById as jest.Mock).mockResolvedValueOnce(mockSiteData);
      (DatabaseAdapter.getSiteSettingsById as jest.Mock).mockResolvedValueOnce(null); // Sin configuración
      
      const result = await DataFetcher.getAgentData('valid-uuid', mockProcessor);
      
      // Verificar que el backstory incluya solo la información del sitio
      expect(result.backstory).toContain('DB backstory');
      expect(result.backstory).toContain('INFORMACIÓN DEL SITIO');
      expect(result.backstory).toContain('Test Site');
      expect(result.backstory).toContain('https://test-site.com');
      
      // Verificar que no incluya la sección de configuración
      expect(result.backstory).not.toContain('CONFIGURACIÓN DEL SITIO');
    });
  });

  describe('getSiteInfo', () => {
    it('debe retornar un objeto vacío si el siteId no es válido', async () => {
      const result = await DataFetcher.getSiteInfo('invalid-uuid');
      
      expect(result.site).toBeNull();
      expect(result.settings).toBeNull();
    });

    it('debe obtener y devolver la información del sitio y sus configuraciones', async () => {
      // Mock de los datos del sitio
      const mockSiteData = {
        id: 'site-uuid',
        name: 'Test Site',
        url: 'https://test-site.com',
        description: 'Test site description',
        resource_urls: { blog: 'https://test-site.com/blog' }
      };
      
      // Mock de la configuración del sitio
      const mockSiteSettings = {
        site_id: 'site-uuid',
        about: 'About the company',
        company_size: 'Medium',
        industry: 'Technology'
      };
      
      // Configurar mocks
      (DatabaseAdapter.getSiteById as jest.Mock).mockResolvedValueOnce(mockSiteData);
      (DatabaseAdapter.getSiteSettingsById as jest.Mock).mockResolvedValueOnce(mockSiteSettings);
      
      const result = await DataFetcher.getSiteInfo('site-uuid');
      
      expect(result.site).toEqual(mockSiteData);
      expect(result.settings).toEqual(mockSiteSettings);
    });
    
    it('debe manejar el caso donde solo se encuentra información del sitio pero no configuración', async () => {
      // Mock de los datos del sitio
      const mockSiteData = {
        id: 'site-uuid',
        name: 'Test Site',
        url: 'https://test-site.com'
      };
      
      // Configurar mocks
      (DatabaseAdapter.getSiteById as jest.Mock).mockResolvedValueOnce(mockSiteData);
      (DatabaseAdapter.getSiteSettingsById as jest.Mock).mockResolvedValueOnce(null);
      
      const result = await DataFetcher.getSiteInfo('site-uuid');
      
      expect(result.site).toEqual(mockSiteData);
      expect(result.settings).toBeNull();
    });
    
    it('debe manejar el caso donde solo se encuentra la configuración pero no la información del sitio', async () => {
      // Mock de la configuración del sitio
      const mockSiteSettings = {
        site_id: 'site-uuid',
        about: 'About the company'
      };
      
      // Configurar mocks
      (DatabaseAdapter.getSiteById as jest.Mock).mockResolvedValueOnce(null);
      (DatabaseAdapter.getSiteSettingsById as jest.Mock).mockResolvedValueOnce(mockSiteSettings);
      
      const result = await DataFetcher.getSiteInfo('site-uuid');
      
      expect(result.site).toBeNull();
      expect(result.settings).toEqual(mockSiteSettings);
    });
    
    it('debe manejar errores durante la obtención de datos', async () => {
      // Configurar mocks para lanzar errores
      (DatabaseAdapter.getSiteById as jest.Mock).mockRejectedValueOnce(new Error('Error en la base de datos'));
      (DatabaseAdapter.getSiteSettingsById as jest.Mock).mockRejectedValueOnce(new Error('Error en la base de datos'));
      
      const result = await DataFetcher.getSiteInfo('site-uuid');
      
      expect(result.site).toBeNull();
      expect(result.settings).toBeNull();
    });
  });
  
  describe('formatSiteInfoAsSummary', () => {
    it('debe generar un resumen formateado de la información del sitio', () => {
      const siteInfo = {
        site: {
          name: 'Test Site',
          url: 'https://test-site.com',
          description: 'Test site description',
          resource_urls: { blog: 'https://test-site.com/blog' },
          competitors: ['competitor1', 'competitor2']
        },
        settings: {
          about: 'About the company',
          company_size: 'Medium',
          industry: 'Technology',
          products: ['product1', 'product2'],
          services: ['service1', 'service2']
        }
      };
      
      const summary = DataFetcher.formatSiteInfoAsSummary(siteInfo);
      
      expect(summary).toContain('INFORMACIÓN DEL SITIO');
      expect(summary).toContain('Test Site');
      expect(summary).toContain('https://test-site.com');
      expect(summary).toContain('Test site description');
      expect(summary).toContain('blog');
      expect(summary).toContain('competitor1');
      
      expect(summary).toContain('CONFIGURACIÓN DEL SITIO');
      expect(summary).toContain('About the company');
      expect(summary).toContain('Medium');
      expect(summary).toContain('Technology');
      expect(summary).toContain('product1');
      expect(summary).toContain('service1');
    });
    
    it('debe generar un resumen solo con información del sitio si no hay configuración', () => {
      const siteInfo = {
        site: {
          name: 'Test Site',
          url: 'https://test-site.com'
        },
        settings: null
      };
      
      const summary = DataFetcher.formatSiteInfoAsSummary(siteInfo);
      
      expect(summary).toContain('INFORMACIÓN DEL SITIO');
      expect(summary).toContain('Test Site');
      expect(summary).not.toContain('CONFIGURACIÓN DEL SITIO');
    });
    
    it('debe generar un resumen solo con configuración si no hay información del sitio', () => {
      const siteInfo = {
        site: null,
        settings: {
          about: 'About the company',
          industry: 'Technology'
        }
      };
      
      const summary = DataFetcher.formatSiteInfoAsSummary(siteInfo);
      
      expect(summary).not.toContain('INFORMACIÓN DEL SITIO');
      expect(summary).toContain('CONFIGURACIÓN DEL SITIO');
      expect(summary).toContain('About the company');
      expect(summary).toContain('Technology');
    });
    
    it('debe retornar un string vacío si no hay información del sitio ni configuración', () => {
      const siteInfo = {
        site: null,
        settings: null
      };
      
      const summary = DataFetcher.formatSiteInfoAsSummary(siteInfo);
      
      expect(summary).toBe('');
    });
  });
  
  describe('getEnhancedAgentData', () => {
    it('debe combinar datos del agente con información del sitio proporcionada explícitamente', async () => {
      // Mock de los datos del agente (sin site_id)
      const mockAgentData = {
        id: 'valid-uuid',
        name: 'DB Agent',
        backstory: 'DB backstory'
      };
      
      // Mock de los datos del sitio
      const mockSiteData = {
        id: 'site-uuid',
        name: 'External Site'
      };
      
      // Mock de la configuración del sitio
      const mockSiteSettings = {
        site_id: 'site-uuid',
        about: 'About the external site'
      };
      
      // Configurar mocks
      (DatabaseAdapter.getAgentById as jest.Mock).mockResolvedValueOnce(mockAgentData);
      (DatabaseAdapter.getAgentFiles as jest.Mock).mockResolvedValueOnce([]);
      (DatabaseAdapter.getSiteById as jest.Mock).mockResolvedValueOnce(mockSiteData);
      (DatabaseAdapter.getSiteSettingsById as jest.Mock).mockResolvedValueOnce(mockSiteSettings);
      
      const result = await DataFetcher.getEnhancedAgentData('valid-uuid', 'site-uuid', mockProcessor);
      
      // Verificar que combina correctamente los datos
      expect(result.agentData.name).toBe('DB Agent');
      expect(result.agentData.site).toEqual(mockSiteData);
      expect(result.agentData.siteSettings).toEqual(mockSiteSettings);
      
      // Verificar que la información del sitio se incluye en el backstory formateado
      expect(result.formattedData.backstory).toContain('DB backstory');
      expect(result.formattedData.backstory).toContain('External Site');
      expect(result.formattedData.backstory).toContain('About the external site');
    });
    
    it('debe usar el site_id del agente si no se proporciona uno explícito', async () => {
      // Mock de los datos del agente (con site_id)
      const mockAgentData = {
        id: 'valid-uuid',
        name: 'DB Agent',
        backstory: 'DB backstory',
        site_id: 'site-uuid'
      };
      
      // Mock de los datos del sitio
      const mockSiteData = {
        id: 'site-uuid',
        name: 'Agent Site'
      };
      
      // Configurar mocks
      (DatabaseAdapter.getAgentById as jest.Mock).mockResolvedValueOnce(mockAgentData);
      (DatabaseAdapter.getAgentFiles as jest.Mock).mockResolvedValueOnce([]);
      (DatabaseAdapter.getSiteById as jest.Mock).mockResolvedValueOnce(mockSiteData);
      (DatabaseAdapter.getSiteSettingsById as jest.Mock).mockResolvedValueOnce(null);
      
      const result = await DataFetcher.getEnhancedAgentData('valid-uuid', undefined, mockProcessor);
      
      // Verificar que usa el site_id del agente
      expect(result.siteInfo.site).toEqual(mockSiteData);
      expect(result.formattedData.backstory).toContain('Agent Site');
    });
    
    it('debe crear un procesador por defecto si no se proporciona uno', async () => {
      // Mock de los datos del agente
      const mockAgentData = {
        id: 'valid-uuid',
        name: 'DB Agent'
      };
      
      // Configurar mocks
      (DatabaseAdapter.getAgentById as jest.Mock).mockResolvedValueOnce(mockAgentData);
      (DatabaseAdapter.getAgentFiles as jest.Mock).mockResolvedValueOnce([]);
      
      const result = await DataFetcher.getEnhancedAgentData('valid-uuid');
      
      // Verificar que usa valores por defecto
      expect(result.formattedData.name).toBe('DB Agent');
    });
  });
}); 