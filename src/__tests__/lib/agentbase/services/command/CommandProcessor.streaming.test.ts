/**
 * Test for CommandProcessor streaming response status update fix
 * 
 * This test verifies that when StreamingResponseProcessor completes successfully,
 * the command status is properly updated to 'completed' in the database.
 */

import { CommandProcessor } from '../../../../../lib/agentbase/services/command/CommandProcessor';
import { CommandService } from '../../../../../lib/agentbase/services/command/CommandService';
import { TargetProcessor } from '../../../../../lib/agentbase/agents/TargetProcessor';
import { CommandStore } from '../../../../../lib/agentbase/services/command/CommandStore';
import { DbCommand, CommandExecutionResult } from '../../../../../lib/agentbase/models/types';

// Mock environment variables
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

// Mock dependencies
jest.mock('../../../../../lib/agentbase/services/command/CommandService');
jest.mock('../../../../../lib/agentbase/agents/TargetProcessor');
jest.mock('../../../../../lib/agentbase/services/command/CommandStore');
jest.mock('../../../../../lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        eq: jest.fn(() => ({
          single: jest.fn(() => Promise.resolve({ data: null, error: null }))
        }))
      })),
      update: jest.fn(() => ({
        eq: jest.fn(() => Promise.resolve({ data: null, error: null }))
      }))
    }))
  }
}));
jest.mock('../../../../../lib/agentbase/adapters/DatabaseAdapter');

describe('CommandProcessor Streaming Status Update Fix', () => {
  let commandProcessor: CommandProcessor;
  let mockCommandService: jest.Mocked<CommandService>;
  let mockTargetProcessor: jest.Mocked<TargetProcessor>;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();
    
    // Create mocked command service
    mockCommandService = {
      updateCommand: jest.fn(),
      updateStatus: jest.fn(),
    } as any;
    
    // Create mocked target processor
    mockTargetProcessor = {
      executeCommand: jest.fn(),
    } as any;
    
    // Create command processor with mocked dependencies
    commandProcessor = new CommandProcessor();
    (commandProcessor as any).commandService = mockCommandService;
    (commandProcessor as any).processors = {
      'target_processor': mockTargetProcessor
    };
  });

  test('should update command status to completed when TargetProcessor returns completed status', async () => {
    // Arrange
    const mockCommand: DbCommand = {
      id: 'test-command-123',
      task: 'Test streaming command',
      status: 'pending',
      user_id: 'test-user',
      created_at: '2023-01-01T00:00:00Z',
      updated_at: '2023-01-01T00:00:00Z',
      targets: [{ content: 'test target' }],
      agent_background: 'Test agent background'
    };

    const mockTargetProcessorResult: CommandExecutionResult = {
      status: 'completed',
      results: [{ content: 'Generated content from streaming' }],
      updatedCommand: {
        ...mockCommand,
        results: [{ content: 'Generated content from streaming' }],
        status: 'completed',
        updated_at: '2023-01-01T01:00:00Z'
      },
      inputTokens: 100,
      outputTokens: 50
    };

    // Mock TargetProcessor to return completed status
    mockTargetProcessor.executeCommand.mockResolvedValue(mockTargetProcessorResult);
    
    // Mock CommandService methods
    mockCommandService.updateCommand.mockResolvedValue(mockCommand);
    mockCommandService.updateStatus.mockResolvedValue(mockCommand);

    // Act
    const result = await (commandProcessor as any).processTargets(mockCommand);

    // Assert
    expect(mockTargetProcessor.executeCommand).toHaveBeenCalledWith({
      ...mockCommand,
      agent_background: mockCommand.agent_background
    });

    // Verify that updateCommand was called with the correct status
    expect(mockCommandService.updateCommand).toHaveBeenCalledWith(
      mockCommand.id,
      expect.objectContaining({
        status: 'completed',
        results: expect.any(Array),
        input_tokens: expect.any(Number),
        output_tokens: expect.any(Number)
      })
    );

    // Verify that CommandStore.setCommand was called with completed status
    expect(CommandStore.setCommand).toHaveBeenCalledWith(
      mockCommand.id,
      expect.objectContaining({
        status: 'completed'
      })
    );

    // Verify the returned command has completed status
    expect(result.status).toBe('completed');
    expect(result.results).toEqual([{ content: 'Generated content from streaming' }]);
  });

  test('should update command status to failed when TargetProcessor returns failed status', async () => {
    // Arrange
    const mockCommand: DbCommand = {
      id: 'test-command-456',
      task: 'Test failing command',
      status: 'pending',
      user_id: 'test-user',
      created_at: '2023-01-01T00:00:00Z',
      updated_at: '2023-01-01T00:00:00Z',
      targets: [{ content: 'test target' }],
      agent_background: 'Test agent background'
    };

    const mockTargetProcessorResult: CommandExecutionResult = {
      status: 'failed',
      error: 'Stream processing failed: timeout'
    };

    // Mock TargetProcessor to return failed status
    mockTargetProcessor.executeCommand.mockResolvedValue(mockTargetProcessorResult);
    
    // Mock CommandService methods
    mockCommandService.updateCommand.mockResolvedValue(mockCommand);
    mockCommandService.updateStatus.mockResolvedValue(mockCommand);

    // Act
    const result = await (commandProcessor as any).processTargets(mockCommand);

    // Assert
    expect(mockTargetProcessor.executeCommand).toHaveBeenCalledWith({
      ...mockCommand,
      agent_background: mockCommand.agent_background
    });

    // Verify the returned command has failed status
    expect(result.status).toBe('failed');
    expect(result.error).toBe('Stream processing failed: timeout');

    // Verify that CommandStore.setCommand was called with failed status
    expect(CommandStore.setCommand).toHaveBeenCalledWith(
      mockCommand.id,
      expect.objectContaining({
        status: 'failed',
        error: 'Stream processing failed: timeout'
      })
    );
  });

  test('should use fallback status update when main database update fails', async () => {
    // Arrange
    const mockCommand: DbCommand = {
      id: 'test-command-789',
      task: 'Test fallback command',
      status: 'pending',
      user_id: 'test-user',
      created_at: '2023-01-01T00:00:00Z',
      updated_at: '2023-01-01T00:00:00Z',
      targets: [{ content: 'test target' }],
      agent_background: 'Test agent background'
    };

    const mockTargetProcessorResult: CommandExecutionResult = {
      status: 'completed',
      results: [{ content: 'Generated content' }],
      updatedCommand: {
        ...mockCommand,
        results: [{ content: 'Generated content' }],
        status: 'completed',
        updated_at: '2023-01-01T01:00:00Z'
      },
      inputTokens: 100,
      outputTokens: 50
    };

    // Mock TargetProcessor to return completed status
    mockTargetProcessor.executeCommand.mockResolvedValue(mockTargetProcessorResult);
    
    // Mock CommandService.updateCommand to fail
    mockCommandService.updateCommand.mockRejectedValue(new Error('Database connection failed'));
    
    // Mock CommandService.updateStatus to succeed (fallback)
    mockCommandService.updateStatus.mockResolvedValue(mockCommand);

    // Act
    const result = await (commandProcessor as any).processTargets(mockCommand);

    // Assert
    expect(mockTargetProcessor.executeCommand).toHaveBeenCalled();

    // Verify that updateCommand was attempted first
    expect(mockCommandService.updateCommand).toHaveBeenCalled();

    // Verify that fallback updateStatus was called
    expect(mockCommandService.updateStatus).toHaveBeenCalledWith(
      mockCommand.id,
      'completed',
      undefined
    );

    // Verify the returned command still has completed status
    expect(result.status).toBe('completed');
  });

  test('should throw error when command has no agent_background', async () => {
    // Arrange
    const mockCommand: DbCommand = {
      id: 'test-command-no-bg',
      task: 'Test command without background',
      status: 'pending',
      user_id: 'test-user',
      created_at: '2023-01-01T00:00:00Z',
      updated_at: '2023-01-01T00:00:00Z',
      targets: [{ content: 'test target' }]
      // No agent_background
    };

    // Act & Assert
    await expect((commandProcessor as any).processTargets(mockCommand))
      .rejects
      .toThrow('El agent_background es obligatorio para procesar targets');

    // Verify TargetProcessor was not called
    expect(mockTargetProcessor.executeCommand).not.toHaveBeenCalled();
  });
});
