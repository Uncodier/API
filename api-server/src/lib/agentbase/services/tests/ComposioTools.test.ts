/**
 * Tests for ComposioTools service
 */
import { ComposioTools } from '../composioTools';

// Mock para OpenAIToolSet de composio-core
jest.mock('composio-core', () => {
  return {
    OpenAIToolSet: jest.fn().mockImplementation(() => {
      return {
        getTools: jest.fn().mockResolvedValue([
          {
            name: 'whatsapp_send_message',
            description: 'Send a WhatsApp message to a contact',
            parameters: {
              type: 'object',
              properties: {
                phone: {
                  type: 'string',
                  description: 'The phone number to send the message to'
                },
                message: {
                  type: 'string',
                  description: 'The message content'
                }
              },
              required: ['phone', 'message']
            }
          },
          {
            name: 'whatsapp_get_contacts',
            description: 'Get a list of WhatsApp contacts',
            parameters: {
              type: 'object',
              properties: {}
            }
          }
        ])
      };
    })
  };
});

describe('ComposioTools', () => {
  let composioTools: ComposioTools;
  
  beforeEach(() => {
    // Guardar el valor original de COMPOSIO_API_KEY
    const originalApiKey = process.env.COMPOSIO_API_KEY;
    
    // Establecer un valor ficticio para las pruebas
    process.env.COMPOSIO_API_KEY = 'test-api-key';
    
    // Crear una instancia para pruebas
    composioTools = new ComposioTools();
    
    // Restaurar el valor original después de la prueba
    afterEach(() => {
      process.env.COMPOSIO_API_KEY = originalApiKey;
    });
  });
  
  test('should initialize with API key from environment', async () => {
    await composioTools.initialize();
    // La prueba pasa si no hay excepciones
  });
  
  test('should format tools correctly', async () => {
    const tools = await composioTools.getTools({ apps: ['whatsapp'] });
    
    // Verificar que se han devuelto 2 herramientas
    expect(tools).toHaveLength(2);
    
    // Verificar la estructura del primer tool
    expect(tools[0]).toEqual({
      name: 'whatsapp_send_message',
      description: 'Send a WhatsApp message to a contact',
      parameters: {
        type: 'object',
        properties: {
          phone: {
            type: 'string',
            description: 'The phone number to send the message to'
          },
          message: {
            type: 'string',
            description: 'The message content'
          }
        },
        required: ['phone', 'message']
      },
      type: 'synchronous',
      status: 'not_initialized',
      provider: 'composio'
    });
    
    // Verificar la estructura del segundo tool
    expect(tools[1]).toEqual({
      name: 'whatsapp_get_contacts',
      description: 'Get a list of WhatsApp contacts',
      parameters: {
        type: 'object',
        properties: {}
      },
      type: 'synchronous',
      status: 'not_initialized',
      provider: 'composio'
    });
  });
  
  test('should handle errors gracefully', async () => {
    // Simular un error eliminando la API key
    process.env.COMPOSIO_API_KEY = '';
    
    // Crear una nueva instancia sin API key
    const errorComposioTools = new ComposioTools();
    
    // Verificar que se lanza un error al inicializar
    await expect(errorComposioTools.initialize()).rejects.toThrow(
      'COMPOSIO_API_KEY es obligatorio para inicializar ComposioTools'
    );
  });
}); 