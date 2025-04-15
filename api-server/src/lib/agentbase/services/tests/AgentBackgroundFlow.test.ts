/**
 * Test para verificar el flujo de agent_background en procesadores
 * 
 * Este test verifica que cuando un comando se ejecuta con un agent_id válido,
 * el agent_background se establece correctamente y se pasa a los procesadores.
 */

import { ProcessorInitializer } from '../ProcessorInitializer';
import { CommandService } from '../CommandService';
import { PortkeyConnector } from '../PortkeyConnector';
import { DbCommand, CommandStatus } from '../../models/types';
import { ToolEvaluator } from '../../agents/ToolEvaluator';
import { TargetProcessor } from '../../agents/TargetProcessor';

// Mock para evitar llamadas reales a APIs
jest.mock('../PortkeyConnector', () => {
  return {
    PortkeyConnector: jest.fn().mockImplementation(() => {
      return {
        callAgent: jest.fn().mockResolvedValue({
          content: JSON.stringify({ test: 'result' }),
          usage: { input_tokens: 10, output_tokens: 20 }
        })
      };
    })
  };
});

// Mock para CommandService
jest.mock('../CommandService', () => {
  return {
    CommandService: jest.fn().mockImplementation(() => {
      const commands = new Map<string, any>();
      const listeners = new Map<string, ((command: any) => void)[]>();

      return {
        on: jest.fn((event: string, callback: (command: any) => void) => {
          if (!listeners.has(event)) {
            listeners.set(event, []);
          }
          const eventListeners = listeners.get(event);
          if (eventListeners) {
            eventListeners.push(callback);
          }
        }),
        submitCommand: jest.fn((command: any) => {
          const id = command.id || `test-cmd-${Date.now()}`;
          const newCommand = { ...command, id, status: 'pending' as CommandStatus };
          commands.set(id, newCommand);
          
          // Disparar evento
          if (listeners.has('commandCreated')) {
            const callbacks = listeners.get('commandCreated');
            if (callbacks) {
              callbacks.forEach(callback => {
                callback(newCommand);
              });
            }
          }
          
          return id;
        }),
        updateStatus: jest.fn((id: string, status: CommandStatus, error?: string) => {
          if (commands.has(id)) {
            const cmd = commands.get(id);
            commands.set(id, { ...cmd, status, error });
          }
        }),
        updateCommand: jest.fn((id: string, updates: any) => {
          if (commands.has(id)) {
            const cmd = commands.get(id);
            commands.set(id, { ...cmd, ...updates });
          }
        }),
        updateResults: jest.fn((id: string, results: any[]) => {
          if (commands.has(id)) {
            const cmd = commands.get(id);
            commands.set(id, { ...cmd, results });
          }
        }),
        getCommandById: jest.fn((id: string) => {
          return commands.get(id);
        }),
        getCommands: jest.fn(() => Array.from(commands.values()))
      };
    })
  };
});

// Mocks para ToolEvaluator y TargetProcessor
interface MockProcessor {
  getId: jest.Mock;
  getName: jest.Mock;
  getCapabilities: jest.Mock;
  executeCommand: jest.Mock;
  lastCommand: DbCommand | null;
}

const mockToolEvaluator: MockProcessor = {
  getId: jest.fn().mockReturnValue('tool_evaluator'),
  getName: jest.fn().mockReturnValue('Tool Evaluator'),
  getCapabilities: jest.fn().mockReturnValue(['tool_evaluation']),
  executeCommand: jest.fn().mockImplementation(async (command: DbCommand) => {
    // Capturar el command recibido para verificar que tenga agent_background
    mockToolEvaluator.lastCommand = command;
    
    return {
      status: 'completed' as CommandStatus,
      results: [
        {
          type: 'tool_evaluation',
          content: {
            updated_tools: command.tools
          }
        }
      ],
      inputTokens: 10,
      outputTokens: 20
    };
  }),
  lastCommand: null
};

const mockTargetProcessor: MockProcessor = {
  getId: jest.fn().mockReturnValue('target_processor'),
  getName: jest.fn().mockReturnValue('Target Processor'),
  getCapabilities: jest.fn().mockReturnValue(['target_processing']),
  executeCommand: jest.fn().mockImplementation(async (command: DbCommand) => {
    // Capturar el command recibido para verificar que tenga agent_background
    mockTargetProcessor.lastCommand = command;
    
    return {
      status: 'completed' as CommandStatus,
      results: [
        {
          type: 'text',
          content: 'Test result'
        }
      ],
      inputTokens: 10,
      outputTokens: 20
    };
  }),
  lastCommand: null
};

// Mock para DatabaseAdapter
jest.mock('../../adapters/DatabaseAdapter', () => {
  return {
    DatabaseAdapter: {
      updateCommand: jest.fn(),
      isValidUUID: jest.fn((uuid: string) => typeof uuid === 'string' && uuid.length > 0)
    }
  };
});

describe('Agent Background Flow', () => {
  let processorInitializer: ProcessorInitializer;
  
  beforeEach(() => {
    // Resetear mocks
    jest.clearAllMocks();
    mockToolEvaluator.lastCommand = null;
    mockTargetProcessor.lastCommand = null;
    
    // Crear una instancia limpia para cada test
    processorInitializer = ProcessorInitializer.getInstance();
    
    // Acceder a la propiedad privada processors para modificarla
    const instance = processorInitializer as any;
    
    // Sobreescribir los procesadores con nuestros mocks
    instance.processors = {
      'default_customer_support_agent': {
        getId: () => 'default_customer_support_agent',
        getName: () => 'Customer Support Agent',
        getCapabilities: () => ['customer_support']
      },
      'tool_evaluator': mockToolEvaluator,
      'target_processor': mockTargetProcessor
    };
    
    // Inicializar
    processorInitializer.initialize();
  });
  
  test('Debe establecer y propagar agent_background cuando hay agent_id', async () => {
    // Crear un comando con agent_id
    const command: DbCommand = {
      id: 'test-command-1',
      task: 'Test task',
      context: 'Test context',
      agent_id: 'default_customer_support_agent',
      tools: [
        {
          type: 'test_tool',
          name: 'test_tool'
        }
      ],
      targets: [
        {
          type: 'text'
        }
      ],
      status: 'pending' as CommandStatus,
      user_id: 'test-user',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    
    // Ejecutar el comando
    await processorInitializer.executeCommand(command);
    
    // Verificar que el agent_background se estableció en la etapa ToolEvaluator
    expect(mockToolEvaluator.executeCommand).toHaveBeenCalled();
    expect(mockToolEvaluator.lastCommand).toBeDefined();
    if (mockToolEvaluator.lastCommand) {
      expect(mockToolEvaluator.lastCommand.agent_background).toBeDefined();
      expect(mockToolEvaluator.lastCommand.agent_background).toContain('Customer Support Agent');
      expect(mockToolEvaluator.lastCommand.agent_background).toContain('default_customer_support_agent');
    }
    
    // Verificar que el agent_background llegó a TargetProcessor
    expect(mockTargetProcessor.executeCommand).toHaveBeenCalled();
    expect(mockTargetProcessor.lastCommand).toBeDefined();
    if (mockTargetProcessor.lastCommand) {
      expect(mockTargetProcessor.lastCommand.agent_background).toBeDefined();
      expect(mockTargetProcessor.lastCommand.agent_background).toContain('Customer Support Agent');
      expect(mockTargetProcessor.lastCommand.agent_background).toContain('default_customer_support_agent');
    }
  });
  
  test('Debe funcionar sin agent_id pero sin establecer agent_background', async () => {
    // Crear un comando sin agent_id
    const command: DbCommand = {
      id: 'test-command-2',
      task: 'Test task without agent',
      context: 'Test context',
      tools: [
        {
          type: 'test_tool',
          name: 'test_tool'
        }
      ],
      targets: [
        {
          type: 'text'
        }
      ],
      status: 'pending' as CommandStatus,
      user_id: 'test-user',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    
    // Ejecutar el comando
    await processorInitializer.executeCommand(command);
    
    // Verificar que se ejecutó ToolEvaluator pero sin agent_background
    expect(mockToolEvaluator.executeCommand).toHaveBeenCalled();
    expect(mockToolEvaluator.lastCommand).toBeDefined();
    if (mockToolEvaluator.lastCommand) {
      expect(mockToolEvaluator.lastCommand.agent_background).toBeUndefined();
    }
    
    // Verificar que se ejecutó TargetProcessor pero sin agent_background
    expect(mockTargetProcessor.executeCommand).toHaveBeenCalled();
    expect(mockTargetProcessor.lastCommand).toBeDefined();
    if (mockTargetProcessor.lastCommand) {
      expect(mockTargetProcessor.lastCommand.agent_background).toBeUndefined();
    }
  });
}); 