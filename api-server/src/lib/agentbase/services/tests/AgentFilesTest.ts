/**
 * Tests para verificar la inclusión de archivos en agent_background
 */
import { ProcessorInitializer } from '../ProcessorInitializer';
import { DatabaseAdapter } from '../../adapters/DatabaseAdapter';
import { Base } from '../../agents/Base';
import { PortkeyConnector } from '../PortkeyConnector';
import { DbCommand } from '../../models/types';

// Mock para DatabaseAdapter.getAgentById
jest.mock('../../adapters/DatabaseAdapter', () => {
  const originalModule = jest.requireActual('../../adapters/DatabaseAdapter');
  return {
    ...originalModule,
    DatabaseAdapter: {
      ...originalModule.DatabaseAdapter,
      isValidUUID: jest.fn().mockImplementation((id) => true),
      getAgentById: jest.fn().mockImplementation(async (agentId) => {
        return {
          id: agentId,
          name: 'Test Agent',
          description: 'Un agente de prueba para verificar la inclusión de archivos.',
          configuration: {
            capabilities: ['testing', 'file_handling']
          }
        };
      }),
      getAgentFiles: jest.fn().mockImplementation(async (agentId) => {
        return [
          {
            id: 'file1',
            name: 'test_data.csv',
            file_path: 'agent-files/test_data.csv',
            file_type: 'csv',
            description: 'Archivo CSV de prueba'
          },
          {
            id: 'file2',
            name: 'reference.txt',
            file_path: 'agent-files/reference.txt',
            file_type: 'text',
            description: 'Archivo de texto de referencia'
          }
        ];
      }),
      getAgentFileContent: jest.fn().mockImplementation(async (filePath) => {
        if (filePath.includes('.csv')) {
          return 'id,name,value\n1,Item 1,100\n2,Item 2,200\n3,Item 3,300';
        }
        return 'Este es un archivo de texto de referencia';
      }),
      updateCommand: jest.fn().mockImplementation(async () => {
        return { success: true };
      })
    }
  };
});

// Mock para la clase Base
class MockAgent extends Base {
  private connector: any;
  
  constructor() {
    // Pasar los argumentos correctos al constructor de Base
    super('test_agent', 'Test Agent', ['testing']);
    this.connector = {
      callLLM: jest.fn()
    };
  }
  
  // Implementar el método abstracto
  async executeCommand(command: DbCommand): Promise<any> {
    return { status: 'completed', results: [] };
  }
}

describe('Agent Files Integration', () => {
  let processorInitializer: ProcessorInitializer;
  
  beforeEach(() => {
    // Limpiar todos los mocks
    jest.clearAllMocks();
    
    // Obtener instancia del inicializador
    processorInitializer = ProcessorInitializer.getInstance();
  });
  
  it('should include CSV file content in agent_background', async () => {
    // Acceder al método privado generateAgentBackground usando cualquier método disponible
    // Nota: Esto es para testing, normalmente no accederíamos a métodos privados
    const generateAgentBackground = (processorInitializer as any).generateAgentBackground.bind(processorInitializer);
    
    // Crear un agente de prueba
    const mockAgent = new MockAgent();
    
    // Generar el background para el agente
    const agentId = 'test-agent-uuid';
    const background = await generateAgentBackground(mockAgent, agentId);
    
    // Verificar que el background incluye la sección de archivos de referencia
    expect(background).toContain('## Reference Files');
    
    // Verificar que el background incluye el contenido del CSV
    expect(background).toContain('### test_data.csv');
    expect(background).toContain('```csv');
    expect(background).toContain('id,name,value');
    expect(background).toContain('1,Item 1,100');
    
    // Verificar que se llamó a los métodos apropiados
    expect(DatabaseAdapter.getAgentById).toHaveBeenCalledWith(agentId);
    expect(DatabaseAdapter.getAgentFiles).toHaveBeenCalledWith(agentId);
    expect(DatabaseAdapter.getAgentFileContent).toHaveBeenCalledWith('agent-files/test_data.csv');
  });
}); 