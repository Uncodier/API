/**
 * Tests for TargetProcessor JSON extraction logic
 * Tests the extractEmbeddedJsonMatchingTargets and findAllJsonArrays methods
 */
import { TargetProcessor } from '../TargetProcessor';
import { PortkeyConnector } from '../../services/PortkeyConnector';
import { DbCommand } from '../../models/types';

// Mock dependencies
jest.mock('../../services/PortkeyConnector');
jest.mock('../../services/command/CommandCache', () => ({
  CommandCache: {
    getCachedCommand: jest.fn(),
    setAgentBackground: jest.fn(),
    cacheCommand: jest.fn()
  }
}));
jest.mock('../../adapters/DatabaseAdapter', () => ({
  DatabaseAdapter: {
    verifyAgentBackground: jest.fn()
  }
}));
jest.mock('../targetEvaluator/validateResults.js', () => ({
  validateResults: jest.fn().mockReturnValue({ isValid: true })
}));

describe('TargetProcessor JSON Extraction', () => {
  let processor: TargetProcessor;
  let mockConnector: jest.Mocked<PortkeyConnector>;
  
  // Standard targets for message/conversation pattern
  const standardTargets = [
    {
      message: {
        content: "message example",
        is_robot: false,
        is_erratic: false,
        is_transactional_message: false
      }
    },
    {
      conversation: {
        title: "conversation title",
        is_robot: false,
        is_erratic: false,
        is_transactional_message: false
      }
    }
  ];

  const createMockCommand = (targets: any[]): DbCommand => ({
    id: 'test-command-id',
    task: 'test-task',
    status: 'pending',
    agent_id: 'test-agent-id',
    agent_background: '# Agent Identity\nYou are a helpful assistant.',
    user_id: 'test-user-id',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    targets
  } as unknown as DbCommand);

  beforeEach(() => {
    jest.clearAllMocks();
    
    mockConnector = {
      callAgent: jest.fn()
    } as unknown as jest.Mocked<PortkeyConnector>;
    
    processor = new TargetProcessor(
      'test-processor-id',
      'Test Processor',
      mockConnector,
      ['target_processing'],
      {
        modelType: 'openai',
        modelId: 'gpt-5-nano',
        temperature: 0.1
      }
    );
  });

  describe('Valid JSON responses', () => {
    test('should parse clean JSON array response', async () => {
      const validResponse = JSON.stringify([
        {
          message: {
            content: "Hola, ¿cómo puedo ayudarte?",
            is_robot: false,
            is_erratic: false,
            is_transactional_message: false
          }
        },
        {
          conversation: {
            title: "Consulta inicial",
            is_robot: false,
            is_erratic: false,
            is_transactional_message: false
          }
        }
      ]);

      mockConnector.callAgent.mockResolvedValue({
        content: validResponse,
        usage: { prompt_tokens: 100, completion_tokens: 50 }
      });

      const result = await processor.executeCommand(createMockCommand(standardTargets));
      
      expect(result.status).toBe('completed');
      expect(result.results).toHaveLength(2);
      expect(result.results![0].message.content).toBe("Hola, ¿cómo puedo ayudarte?");
      expect(result.results![1].conversation.title).toBe("Consulta inicial");
    });
  });

  describe('Embedded JSON extraction - text before JSON', () => {
    test('should extract JSON when LLM adds text before the array', async () => {
      const responseWithTextBefore = `I'll qualify question flow.
[
  {
    "message": {
      "content": "Claro. En netWorth MX ofrecemos principalmente PPR.",
      "is_robot": false,
      "is_erratic": false,
      "is_transactional_message": false
    }
  },
  {
    "conversation": {
      "title": "Servicios netWorth MX (PPR / Empresas)",
      "is_robot": false,
      "is_erratic": false,
      "is_transactional_message": false
    }
  }
]`;

      mockConnector.callAgent.mockResolvedValue({
        content: responseWithTextBefore,
        usage: { prompt_tokens: 100, completion_tokens: 50 }
      });

      const result = await processor.executeCommand(createMockCommand(standardTargets));
      
      expect(result.status).toBe('completed');
      expect(result.results).toHaveLength(2);
      expect(result.results![0].message.content).toContain("netWorth MX");
      expect(result.results![1].conversation.title).toContain("Servicios netWorth");
    });

    test('should extract JSON with tool_evaluation text before', async () => {
      const responseWithToolEval = `[tool_evaluation]
[tool_evaluation to=QUALIFY_LEAD format=json
{"site_id":"netWorth B2B","status":"qualified"}]
[
  {
    "message": {
      "content": "Perfecto, Eliel. Para ayudarte con un PPR dime: ¿Qué edad tienes?",
      "is_robot": false,
      "is_erratic": false,
      "is_transactional_message": false
    }
  },
  {
    "conversation": {
      "title": "PPR individual - Eliel (WhatsApp)",
      "is_robot": false,
      "is_erratic": false,
      "is_transactional_message": false
    }
  }
]`;

      mockConnector.callAgent.mockResolvedValue({
        content: responseWithToolEval,
        usage: { prompt_tokens: 100, completion_tokens: 50 }
      });

      const result = await processor.executeCommand(createMockCommand(standardTargets));
      
      expect(result.status).toBe('completed');
      expect(result.results).toHaveLength(2);
      expect(result.results![0].message.content).toContain("PPR");
      expect(result.results![1].conversation.title).toContain("Eliel");
    });
  });

  describe('Embedded JSON extraction - text before and after JSON', () => {
    test('should extract JSON when LLM adds text before and after', async () => {
      const responseWithTextAround = `Let me process your request.

[
  {
    "message": {
      "content": "Buenos días, ¿en qué puedo ayudarte?",
      "is_robot": false,
      "is_erratic": false,
      "is_transactional_message": false
    }
  },
  {
    "conversation": {
      "title": "Nueva consulta",
      "is_robot": false,
      "is_erratic": false,
      "is_transactional_message": false
    }
  }
]

Hope this helps!`;

      mockConnector.callAgent.mockResolvedValue({
        content: responseWithTextAround,
        usage: { prompt_tokens: 100, completion_tokens: 50 }
      });

      const result = await processor.executeCommand(createMockCommand(standardTargets));
      
      expect(result.status).toBe('completed');
      expect(result.results).toHaveLength(2);
      expect(result.results![0].message.content).toBe("Buenos días, ¿en qué puedo ayudarte?");
    });
  });

  describe('Multiple JSON arrays in text', () => {
    test('should select the correct JSON array matching targets structure', async () => {
      const responseWithMultipleArrays = `Here's a sample: [1, 2, 3]

And another: ["a", "b"]

But the real response is:
[
  {
    "message": {
      "content": "Este es el mensaje correcto",
      "is_robot": false,
      "is_erratic": false,
      "is_transactional_message": false
    }
  },
  {
    "conversation": {
      "title": "Título correcto",
      "is_robot": false,
      "is_erratic": false,
      "is_transactional_message": false
    }
  }
]

Some additional arrays: [true, false]`;

      mockConnector.callAgent.mockResolvedValue({
        content: responseWithMultipleArrays,
        usage: { prompt_tokens: 100, completion_tokens: 50 }
      });

      const result = await processor.executeCommand(createMockCommand(standardTargets));
      
      expect(result.status).toBe('completed');
      expect(result.results).toHaveLength(2);
      expect(result.results![0].message.content).toBe("Este es el mensaje correcto");
      expect(result.results![1].conversation.title).toBe("Título correcto");
    });
  });

  describe('JSON with wrong number of elements', () => {
    test('should fail when embedded JSON has different number of elements than targets', async () => {
      // Adding text before JSON to force it through extraction path
      const responseWithWrongCount = `Here's my response:
[
  {
    "message": {
      "content": "Solo un elemento",
      "is_robot": false,
      "is_erratic": false,
      "is_transactional_message": false
    }
  }
]`;

      // First call fails, second call also fails (to test retry exhaustion)
      mockConnector.callAgent
        .mockResolvedValueOnce({
          content: responseWithWrongCount,
          usage: { prompt_tokens: 100, completion_tokens: 50 }
        })
        .mockResolvedValueOnce({
          content: responseWithWrongCount,
          usage: { prompt_tokens: 100, completion_tokens: 50 }
        });

      const result = await processor.executeCommand(createMockCommand(standardTargets));
      
      expect(result.status).toBe('failed');
      expect(result.error).toContain('Could not extract valid JSON');
    });
  });

  describe('JSON with wrong structure', () => {
    test('should fail when embedded JSON elements dont match target keys', async () => {
      // Adding text before JSON to force it through extraction path
      const responseWithWrongKeys = `Processing your request:
[
  {
    "wrong_key": {
      "content": "Wrong structure",
      "is_robot": false
    }
  },
  {
    "also_wrong": {
      "title": "Wrong key"
    }
  }
]`;

      mockConnector.callAgent
        .mockResolvedValueOnce({
          content: responseWithWrongKeys,
          usage: { prompt_tokens: 100, completion_tokens: 50 }
        })
        .mockResolvedValueOnce({
          content: responseWithWrongKeys,
          usage: { prompt_tokens: 100, completion_tokens: 50 }
        });

      const result = await processor.executeCommand(createMockCommand(standardTargets));
      
      expect(result.status).toBe('failed');
      expect(result.error).toContain('Could not extract valid JSON');
    });
  });

  describe('No valid JSON in response', () => {
    test('should fail when response contains no valid JSON', async () => {
      const responseWithNoJson = `This is just plain text without any JSON structure.
It should fail to parse and trigger retries.`;

      mockConnector.callAgent
        .mockResolvedValueOnce({
          content: responseWithNoJson,
          usage: { prompt_tokens: 100, completion_tokens: 50 }
        })
        .mockResolvedValueOnce({
          content: responseWithNoJson,
          usage: { prompt_tokens: 100, completion_tokens: 50 }
        });

      const result = await processor.executeCommand(createMockCommand(standardTargets));
      
      expect(result.status).toBe('failed');
      expect(result.error).toContain('Could not extract valid JSON');
    });
  });

  describe('Retry mechanism', () => {
    test('should retry once and succeed on second attempt', async () => {
      const badResponse = `Invalid response without proper JSON`;
      const goodResponse = JSON.stringify([
        {
          message: {
            content: "Success on retry",
            is_robot: false,
            is_erratic: false,
            is_transactional_message: false
          }
        },
        {
          conversation: {
            title: "Retry success",
            is_robot: false,
            is_erratic: false,
            is_transactional_message: false
          }
        }
      ]);

      mockConnector.callAgent
        .mockResolvedValueOnce({
          content: badResponse,
          usage: { prompt_tokens: 100, completion_tokens: 50 }
        })
        .mockResolvedValueOnce({
          content: goodResponse,
          usage: { prompt_tokens: 100, completion_tokens: 50 }
        });

      const result = await processor.executeCommand(createMockCommand(standardTargets));
      
      expect(result.status).toBe('completed');
      expect(result.results![0].message.content).toBe("Success on retry");
      expect(mockConnector.callAgent).toHaveBeenCalledTimes(2);
      // Token usage should be accumulated
      expect(result.inputTokens).toBe(200);
      expect(result.outputTokens).toBe(100);
    });

    test('should accumulate token usage across retries', async () => {
      const badResponse = `Bad response`;
      
      mockConnector.callAgent
        .mockResolvedValueOnce({
          content: badResponse,
          usage: { prompt_tokens: 150, completion_tokens: 75 }
        })
        .mockResolvedValueOnce({
          content: badResponse,
          usage: { prompt_tokens: 200, completion_tokens: 100 }
        });

      const result = await processor.executeCommand(createMockCommand(standardTargets));
      
      expect(result.status).toBe('failed');
      // Should have called twice (max retries)
      expect(mockConnector.callAgent).toHaveBeenCalledTimes(2);
    });
  });

  describe('Complex real-world scenarios', () => {
    test('should handle nested JSON in message content (string escaped)', async () => {
      // This simulates the problematic case where JSON is embedded as string in content
      const problematicResponse = `I'll qualify question flow.
[
  {
    "message": {
      "content": "[tool_evaluation]\\n[{...}]\\nReal message content here",
      "is_robot": false,
      "is_erratic": false,
      "is_transactional_message": false
    }
  },
  {
    "conversation": {
      "title": "Test conversation",
      "is_robot": false,
      "is_erratic": false,
      "is_transactional_message": false
    }
  }
]`;

      mockConnector.callAgent.mockResolvedValue({
        content: problematicResponse,
        usage: { prompt_tokens: 100, completion_tokens: 50 }
      });

      const result = await processor.executeCommand(createMockCommand(standardTargets));
      
      expect(result.status).toBe('completed');
      expect(result.results).toHaveLength(2);
      expect(result.results![0].message).toBeDefined();
      expect(result.results![1].conversation).toBeDefined();
    });

    test('should handle Spanish/unicode content correctly', async () => {
      const spanishResponse = `Aquí está la respuesta:
[
  {
    "message": {
      "content": "¡Hola! ¿Cómo puedo ayudarte con el Plan Personal de Retiro (PPR)?",
      "is_robot": false,
      "is_erratic": false,
      "is_transactional_message": false
    }
  },
  {
    "conversation": {
      "title": "Consulta PPR - José García",
      "is_robot": false,
      "is_erratic": false,
      "is_transactional_message": false
    }
  }
]`;

      mockConnector.callAgent.mockResolvedValue({
        content: spanishResponse,
        usage: { prompt_tokens: 100, completion_tokens: 50 }
      });

      const result = await processor.executeCommand(createMockCommand(standardTargets));
      
      expect(result.status).toBe('completed');
      expect(result.results![0].message.content).toContain("¡Hola!");
      expect(result.results![1].conversation.title).toContain("José García");
    });
  });

  describe('Different target structures', () => {
    test('should work with single target', async () => {
      const singleTarget = [{
        response: {
          text: "",
          status: ""
        }
      }];

      const singleResponse = `Here's my response:
[
  {
    "response": {
      "text": "Single target response",
      "status": "success"
    }
  }
]`;

      mockConnector.callAgent.mockResolvedValue({
        content: singleResponse,
        usage: { prompt_tokens: 100, completion_tokens: 50 }
      });

      const result = await processor.executeCommand(createMockCommand(singleTarget));
      
      expect(result.status).toBe('completed');
      expect(result.results).toHaveLength(1);
      expect(result.results![0].response.text).toBe("Single target response");
    });

    test('should work with three targets', async () => {
      const threeTargets = [
        { message: { content: "" } },
        { conversation: { title: "" } },
        { metadata: { timestamp: "" } }
      ];

      const threeResponse = `Processing:
[
  { "message": { "content": "First" } },
  { "conversation": { "title": "Second" } },
  { "metadata": { "timestamp": "2024-01-01" } }
]`;

      mockConnector.callAgent.mockResolvedValue({
        content: threeResponse,
        usage: { prompt_tokens: 100, completion_tokens: 50 }
      });

      const result = await processor.executeCommand(createMockCommand(threeTargets));
      
      expect(result.status).toBe('completed');
      expect(result.results).toHaveLength(3);
      expect(result.results![0].message.content).toBe("First");
      expect(result.results![1].conversation.title).toBe("Second");
      expect(result.results![2].metadata.timestamp).toBe("2024-01-01");
    });
  });
});
