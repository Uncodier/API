/**
 * Tests para verificar la inclusión de archivos en agent_background
 */

// Mock para Supabase antes de cualquier importación
jest.mock('../../../database/supabase-client', () => ({
  supabase: {
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        eq: jest.fn(() => ({
          single: jest.fn(() => Promise.resolve({ data: null, error: null }))
        }))
      })),
      insert: jest.fn(() => Promise.resolve({ data: null, error: null })),
      update: jest.fn(() => Promise.resolve({ data: null, error: null })),
      delete: jest.fn(() => Promise.resolve({ data: null, error: null }))
    }))
  },
  supabaseAdmin: {
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        eq: jest.fn(() => ({
          single: jest.fn(() => Promise.resolve({ data: null, error: null }))
        }))
      }))
    }))
  }
}));

// Mock para command-db
jest.mock('../../../database/command-db', () => ({
  getCommandById: jest.fn(),
  createCommand: jest.fn(),
  updateCommand: jest.fn(),
  deleteCommand: jest.fn()
}));

import { AgentBackgroundService } from '../agent/AgentBackgroundService';
import { DatabaseAdapter } from '../../adapters/DatabaseAdapter';
import { Base } from '../../agents/Base';
import { DbCommand } from '../../models/types';

// Mock para DatabaseAdapter
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
          },
          {
            id: 'file3',
            name: 'documentation.md',
            file_path: 'agent-files/documentation.md',
            file_type: 'md',
            description: 'Archivo Markdown de documentación'
          },
          {
            id: 'file4',
            name: 'guide.markdown',
            file_path: 'agent-files/guide.markdown',
            file_type: 'markdown',
            description: 'Archivo Markdown de guía'
          }
        ];
      }),
      getAgentFileContent: jest.fn().mockImplementation(async (filePath) => {
        if (filePath.includes('.csv')) {
          return 'id,name,value\n1,Item 1,100\n2,Item 2,200\n3,Item 3,300';
        } else if (filePath.includes('.md') || filePath.includes('.markdown')) {
          return `# Documentación de Ejemplo

## Introducción
Este es un archivo de documentación de ejemplo en formato Markdown.

### Características
- Característica 1
- Característica 2
- Característica 3

### Código de ejemplo
\`\`\`javascript
console.log('Hola mundo');
\`\`\`

## Conclusión
Esta documentación ayuda al agente a entender mejor el contexto.`;
        }
        return 'Este es un archivo de texto de referencia';
      }),
      updateCommand: jest.fn().mockImplementation(async () => {
        return { success: true };
      })
    }
  };
});

// Mock para FileProcessingService
jest.mock('../FileProcessingService', () => {
  return {
    FileProcessingService: {
      getInstance: jest.fn().mockReturnValue({
        appendAgentFilesToBackground: jest.fn().mockImplementation(async (background, files) => {
          if (!files || files.length === 0) return background;
          
          let updatedBackground = background + '\n\n## Reference Files';
          
          for (const file of files) {
            const fileName = file.name;
            const fileType = file.file_type?.toLowerCase() || '';
            
            if (fileType === 'csv' || fileName.endsWith('.csv')) {
              const content = 'id,name,value\n1,Item 1,100\n2,Item 2,200\n3,Item 3,300';
              updatedBackground += `\n\n### ${fileName}\n\`\`\`csv\n${content}\n\`\`\``;
            } else if (fileType === 'md' || fileType === 'markdown' || fileName.endsWith('.md') || fileName.endsWith('.markdown')) {
              const content = `# Documentación de Ejemplo

## Introducción
Este es un archivo de documentación de ejemplo en formato Markdown.

### Características
- Característica 1
- Característica 2
- Característica 3

### Código de ejemplo
\`\`\`javascript
console.log('Hola mundo');
\`\`\`

## Conclusión
Esta documentación ayuda al agente a entender mejor el contexto.`;
              updatedBackground += `\n\n### ${fileName}\n\`\`\`markdown\n${content}\n\`\`\``;
            } else {
              updatedBackground += `\n\n### ${fileName}\nReference file of type: ${fileType}`;
            }
          }
          
          return updatedBackground;
        })
      })
    }
  };
});

// Mock para AgentCacheService
jest.mock('../agent/AgentCacheService', () => {
  return {
    AgentCacheService: {
      getInstance: jest.fn().mockReturnValue({
        getAgentData: jest.fn().mockReturnValue(null),
        setAgentData: jest.fn(),
        getBackgroundData: jest.fn().mockReturnValue(null),
        setBackgroundData: jest.fn()
      })
    }
  };
});

// Mock para DataFetcher
jest.mock('../agent/BackgroundServices/DataFetcher', () => {
  return {
    DataFetcher: {
      getAgentData: jest.fn().mockImplementation(async (agentId) => {
        const files = await DatabaseAdapter.getAgentFiles(agentId);
        return {
          id: agentId,
          name: 'Test Agent',
          description: 'Un agente de prueba para verificar la inclusión de archivos.',
          capabilities: ['testing', 'file_handling'],
          files: files
        };
      }),
      getCommandCapabilities: jest.fn().mockReturnValue([]),
      extractProcessorData: jest.fn().mockReturnValue({
        name: 'Test Agent',
        description: 'Test agent description'
      }),
      extractProcessorCapabilities: jest.fn().mockReturnValue(['testing']),
      getSiteInfo: jest.fn().mockReturnValue(null)
    }
  };
});

// Mock para BackgroundBuilder
jest.mock('../agent/BackgroundServices/BackgroundBuilder', () => {
  return {
    BackgroundBuilder: {
      buildAgentPrompt: jest.fn().mockImplementation((id, name, description, capabilities) => {
        return `# Agent: ${name}

## Description
${description}

## Capabilities  
${capabilities.join(', ')}

## Instructions
You are ${name}. ${description}`;
      }),
      createEmergencyBackground: jest.fn().mockImplementation((id, name, capabilities) => {
        return `# Emergency Background for ${name}
Capabilities: ${capabilities.join(', ')}`;
      })
    }
  };
});

// Mock Agent class que extiende Base
class MockAgent extends Base {
  constructor() {
    super('test_agent', 'Test Agent', ['testing']);
  }
  
  async executeCommand(command: DbCommand): Promise<any> {
    return { status: 'completed', results: [] };
  }
}

describe('Agent Files Integration', () => {
  let agentBackgroundService: AgentBackgroundService;
  
  beforeEach(() => {
    // Limpiar todos los mocks
    jest.clearAllMocks();
    
    // Obtener instancia del servicio
    agentBackgroundService = AgentBackgroundService.getInstance();
  });
  
  it('should include CSV file content in agent_background', async () => {
    // Crear un agente de prueba
    const mockAgent = new MockAgent();
    
    // Generar el background para el agente
    const agentId = 'test-agent-uuid';
    const background = await agentBackgroundService.generateAgentBackground(mockAgent, agentId);
    
    // Verificar que el background incluye la sección de archivos de referencia
    expect(background).toContain('## Reference Files');
    
    // Verificar que el background incluye el contenido del CSV
    expect(background).toContain('### test_data.csv');
    expect(background).toContain('```csv');
    expect(background).toContain('id,name,value');
    expect(background).toContain('1,Item 1,100');
    
    // Verificar que se llamó a los métodos apropiados
    expect(DatabaseAdapter.getAgentFiles).toHaveBeenCalledWith(agentId);
  });

  it('should include Markdown file content in agent_background', async () => {
    // Crear un agente de prueba
    const mockAgent = new MockAgent();
    
    // Generar el background para el agente
    const agentId = 'test-agent-uuid';
    const background = await agentBackgroundService.generateAgentBackground(mockAgent, agentId);
    
    // Verificar que el background incluye la sección de archivos de referencia
    expect(background).toContain('## Reference Files');
    
    // Verificar que el background incluye el contenido del Markdown
    expect(background).toContain('### documentation.md');
    expect(background).toContain('```markdown');
    expect(background).toContain('# Documentación de Ejemplo');
    expect(background).toContain('## Introducción');
    expect(background).toContain('- Característica 1');
    
    // Verificar que también incluye el archivo .markdown
    expect(background).toContain('### guide.markdown');
    
    // Verificar que se llamó a los métodos apropiados
    expect(DatabaseAdapter.getAgentFiles).toHaveBeenCalledWith(agentId);
  });

  it('should include both CSV and Markdown files in agent_background', async () => {
    // Crear un agente de prueba
    const mockAgent = new MockAgent();
    
    // Generar el background para el agente
    const agentId = 'test-agent-uuid';
    const background = await agentBackgroundService.generateAgentBackground(mockAgent, agentId);
    
    // Verificar que incluye ambos tipos de archivos
    expect(background).toContain('### test_data.csv');
    expect(background).toContain('```csv');
    expect(background).toContain('### documentation.md');
    expect(background).toContain('```markdown');
    
    // Verificar que incluye archivos de texto como referencia únicamente
    expect(background).toContain('### reference.txt');
    expect(background).toContain('Reference file of type: text');
    
    console.log('Generated background preview:', background.substring(0, 500));
  });

  it('should handle empty files array gracefully', async () => {
    // Mock para que getAgentFiles retorne un array vacío
    (DatabaseAdapter.getAgentFiles as jest.Mock).mockResolvedValueOnce([]);
    
    const mockAgent = new MockAgent();
    const agentId = 'test-agent-uuid';
    const background = await agentBackgroundService.generateAgentBackground(mockAgent, agentId);
    
    // Verificar que el background se genera correctamente incluso sin archivos
    expect(background).toContain('Agent: Test Agent');
    expect(background).toContain('testing');
  });

  it('should handle missing agent gracefully', async () => {
    // Mock para que getAgentData retorne null (agente no encontrado)
    const DataFetcher = require('../agent/BackgroundServices/DataFetcher').DataFetcher;
    DataFetcher.getAgentData.mockResolvedValueOnce(null);
    
    const mockAgent = new MockAgent();
    const agentId = 'non-existent-agent';
    const background = await agentBackgroundService.generateAgentBackground(mockAgent, agentId);
    
    // Verificar que se genera un background por defecto desde el procesador
    expect(background).toContain('Test Agent');
    expect(background).toContain('testing');
  });
}); 