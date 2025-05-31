import { WorkflowService } from '@/lib/services/workflow-service';

// Mock Temporal client
const mockWorkflowHandle = {
  workflowId: 'test-workflow-id',
  firstExecutionRunId: 'test-run-id',
  describe: jest.fn(),
  cancel: jest.fn()
};

const mockClient = {
  workflow: {
    start: jest.fn(),
    getHandle: jest.fn()
  }
};

const mockConnection = {
  close: jest.fn()
};

// Mock @temporalio/client
jest.mock('@temporalio/client', () => ({
  Connection: {
    connect: jest.fn()
  },
  Client: jest.fn()
}));

describe('WorkflowService', () => {
  let workflowService: WorkflowService;
  const { Connection, Client } = require('@temporalio/client');

  beforeEach(() => {
    workflowService = WorkflowService.getInstance();
    
    // Reset all mocks
    jest.clearAllMocks();
    
    // Reset the singleton instance to force re-initialization
    (workflowService as any).client = null;
    (workflowService as any).connection = null;
    
    // Setup mocks
    Connection.connect.mockResolvedValue(mockConnection);
    Client.mockImplementation(() => mockClient);
    mockClient.workflow.start.mockResolvedValue(mockWorkflowHandle);
    mockClient.workflow.getHandle.mockReturnValue(mockWorkflowHandle);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('sendEmailFromAgent', () => {
    const mockEmailArgs = {
      email: 'test@example.com',
      from: 'noreply@test.com',
      subject: 'Test Subject',
      message: 'Test message content',
      site_id: 'test-site-123'
    };

    it('debería enviar email exitosamente usando Temporal', async () => {
      const result = await workflowService.sendEmailFromAgent(mockEmailArgs);

      expect(Connection.connect).toHaveBeenCalledWith({
        address: 'localhost:7233'
      });

      expect(mockClient.workflow.start).toHaveBeenCalledWith('sendEmailFromAgent', {
        args: [mockEmailArgs],
        taskQueue: 'email-task-queue',
        workflowId: expect.stringMatching(/^send-email-\d+-[a-z0-9]+$/)
      });

      expect(result).toEqual({
        success: true,
        executionId: 'test-run-id',
        workflowId: 'test-workflow-id',
        runId: 'test-run-id',
        status: 'running'
      });
    });

    it('debería usar variables de entorno para configuración de Temporal', async () => {
      const originalServerUrl = process.env.TEMPORAL_SERVER_URL;
      const originalNamespace = process.env.TEMPORAL_NAMESPACE;
      
      process.env.TEMPORAL_SERVER_URL = 'temporal.example.com:7233';
      process.env.TEMPORAL_NAMESPACE = 'test-namespace';

      // Reset client to force re-initialization with new env vars
      (workflowService as any).client = null;
      (workflowService as any).connection = null;

      await workflowService.sendEmailFromAgent(mockEmailArgs);

      expect(Connection.connect).toHaveBeenCalledWith({
        address: 'temporal.example.com:7233'
      });

      expect(Client).toHaveBeenCalledWith({
        connection: mockConnection,
        namespace: 'test-namespace'
      });

      // Restore original env
      process.env.TEMPORAL_SERVER_URL = originalServerUrl;
      process.env.TEMPORAL_NAMESPACE = originalNamespace;
    });

    it('debería fallar cuando faltan argumentos requeridos', async () => {
      const incompleteArgs = {
        email: 'test@example.com',
        from: '',
        subject: 'Test Subject',
        message: 'Test message',
        site_id: 'test-site-123'
      };

      const result = await workflowService.sendEmailFromAgent(incompleteArgs);

      expect(result).toEqual({
        success: false,
        error: {
          code: 'INVALID_ARGUMENTS',
          message: 'Se requieren email, from, subject, message y site_id para enviar el email'
        }
      });

      expect(mockClient.workflow.start).not.toHaveBeenCalled();
    });

    it('debería manejar errores de conexión con Temporal', async () => {
      // Reset client to ensure fresh initialization
      (workflowService as any).client = null;
      (workflowService as any).connection = null;
      
      Connection.connect.mockRejectedValueOnce(new Error('Connection failed'));

      const result = await workflowService.sendEmailFromAgent(mockEmailArgs);

      expect(result).toEqual({
        success: false,
        error: {
          code: 'WORKFLOW_EXECUTION_ERROR',
          message: 'Connection failed'
        }
      });
    });

    it('debería usar opciones personalizadas de workflow', async () => {
      const customOptions = {
        taskQueue: 'custom-queue',
        workflowId: 'custom-workflow-id'
      };

      await workflowService.sendEmailFromAgent(mockEmailArgs, customOptions);

      expect(mockClient.workflow.start).toHaveBeenCalledWith('sendEmailFromAgent', {
        args: [mockEmailArgs],
        taskQueue: 'custom-queue',
        workflowId: 'custom-workflow-id'
      });
    });

    it('debería validar argumentos requeridos', async () => {
      const invalidArgs = {
        email: '',
        from: '',
        subject: '',
        message: '',
        site_id: ''
      };

      const result = await workflowService.sendEmailFromAgent(invalidArgs);

      expect(result).toEqual({
        success: false,
        error: {
          code: 'INVALID_ARGUMENTS',
          message: 'Se requieren email, from, subject, message y site_id para enviar el email'
        }
      });

      expect(mockClient.workflow.start).not.toHaveBeenCalled();
    });

    it('debería validar argumentos incompletos', async () => {
      const incompleteArgs = {
        email: 'test@example.com',
        from: '',
        subject: 'Test Subject',
        message: 'Test message',
        site_id: 'test-site-123'
      };

      const result = await workflowService.sendEmailFromAgent(incompleteArgs);

      expect(result).toEqual({
        success: false,
        error: {
          code: 'INVALID_ARGUMENTS',
          message: 'Se requieren email, from, subject, message y site_id para enviar el email'
        }
      });

      expect(mockClient.workflow.start).not.toHaveBeenCalled();
    });
  });

  describe('executeWorkflow', () => {
    it('debería ejecutar workflow genérico exitosamente', async () => {
      const result = await workflowService.executeWorkflow(
        'customWorkflow',
        { param1: 'value1' }
      );

      expect(mockClient.workflow.start).toHaveBeenCalledWith('customWorkflow', {
        args: [{ param1: 'value1' }],
        taskQueue: 'default-task-queue',
        workflowId: expect.stringMatching(/^customWorkflow-\d+-[a-z0-9]+$/)
      });

      expect(result).toEqual({
        success: true,
        executionId: 'test-run-id',
        workflowId: 'test-workflow-id',
        runId: 'test-run-id',
        status: 'running'
      });
    });
  });

  describe('getWorkflowStatus', () => {
    it('debería obtener el estado del workflow', async () => {
      const mockDescription = {
        workflowId: 'test-workflow-id',
        runId: 'test-run-id',
        status: { name: 'RUNNING' }
      };

      mockWorkflowHandle.describe.mockResolvedValueOnce(mockDescription);

      const result = await workflowService.getWorkflowStatus('test-workflow-id');

      expect(mockClient.workflow.getHandle).toHaveBeenCalledWith('test-workflow-id', undefined);
      expect(mockWorkflowHandle.describe).toHaveBeenCalled();

      expect(result).toEqual({
        success: true,
        workflowId: 'test-workflow-id',
        runId: 'test-run-id',
        status: 'running'
      });
    });
  });

  describe('cancelWorkflow', () => {
    it('debería cancelar el workflow', async () => {
      const result = await workflowService.cancelWorkflow('test-workflow-id');

      expect(mockClient.workflow.getHandle).toHaveBeenCalledWith('test-workflow-id', undefined);
      expect(mockWorkflowHandle.cancel).toHaveBeenCalled();

      expect(result).toEqual({
        success: true,
        workflowId: 'test-workflow-id',
        runId: undefined,
        status: 'cancelled'
      });
    });
  });

  describe('closeConnection', () => {
    it('debería cerrar la conexión con Temporal', async () => {
      // Primero inicializar la conexión
      await workflowService.sendEmailFromAgent({
        email: 'test@example.com',
        from: 'test@example.com',
        subject: 'Test',
        message: 'Test',
        site_id: 'test-site-123'
      });

      await workflowService.closeConnection();

      expect(mockConnection.close).toHaveBeenCalled();
    });
  });

  describe('Singleton pattern', () => {
    it('debería retornar la misma instancia', () => {
      const instance1 = WorkflowService.getInstance();
      const instance2 = WorkflowService.getInstance();

      expect(instance1).toBe(instance2);
    });
  });

  describe('scheduleCustomerSupport', () => {
    const mockAnalysisData = [
      {
        summary: "Customer inquiry about product features",
        insights: ["interested in premium features", "potential upgrade candidate"],
        sentiment: "positive" as const,
        priority: "medium" as const,
        action_items: ["Follow up within 24 hours", "Send product comparison"],
        response: ["Thank you for your inquiry", "We'll get back to you soon"],
        lead_extraction: {
          contact_info: {
            name: "John Doe",
            email: "john@example.com",
            phone: "+1234567890",
            company: "Example Corp"
          },
          intent: "inquiry" as const,
          requirements: ["premium features", "enterprise pricing"],
          budget_indication: "10k-50k",
          timeline: "Q4 2024",
          decision_maker: "yes" as const,
          source: "website" as const
        },
        commercial_opportunity: {
          requires_response: true,
          response_type: "commercial" as const,
          priority_level: "high" as const,
          suggested_actions: ["Schedule demo", "Send pricing"],
          potential_value: "high" as const,
          next_steps: ["Demo scheduling", "Proposal preparation"]
        }
      }
    ];

    const mockScheduleParams = {
      analysisArray: mockAnalysisData,
      site_id: 'test-site-123',
      userId: 'test-user-456'
    };

    it('debería programar customer support exitosamente', async () => {
      const result = await workflowService.scheduleCustomerSupport(mockScheduleParams);

      expect(mockClient.workflow.start).toHaveBeenCalledWith('scheduleCustomerSupportMessagesWorkflow', {
        args: [mockScheduleParams],
        taskQueue: 'default',
        workflowId: expect.stringMatching(/^customer-support-\d+-[a-z0-9]+$/)
      });

      expect(result).toEqual({
        success: true,
        executionId: 'test-run-id',
        workflowId: 'test-workflow-id',
        runId: 'test-run-id',
        status: 'running'
      });
    });

    it('debería validar que analysisArray sea requerido', async () => {
      const invalidParams = {
        ...mockScheduleParams,
        analysisArray: undefined as any
      };

      const result = await workflowService.scheduleCustomerSupport(invalidParams);

      expect(result).toEqual({
        success: false,
        error: {
          code: 'INVALID_ARGUMENTS',
          message: 'Se requiere analysisArray como un arreglo válido'
        }
      });

      expect(mockClient.workflow.start).not.toHaveBeenCalled();
    });

    it('debería validar que site_id sea requerido', async () => {
      const invalidParams = {
        ...mockScheduleParams,
        site_id: ''
      };

      const result = await workflowService.scheduleCustomerSupport(invalidParams);

      expect(result).toEqual({
        success: false,
        error: {
          code: 'INVALID_ARGUMENTS',
          message: 'Se requiere site_id para programar el soporte al cliente'
        }
      });

      expect(mockClient.workflow.start).not.toHaveBeenCalled();
    });

    it('debería validar que userId sea requerido', async () => {
      const invalidParams = {
        ...mockScheduleParams,
        userId: undefined
      };

      const result = await workflowService.scheduleCustomerSupport(invalidParams);

      expect(result).toEqual({
        success: false,
        error: {
          code: 'INVALID_ARGUMENTS',
          message: 'Se requiere userId para programar el soporte al cliente'
        }
      });

      expect(mockClient.workflow.start).not.toHaveBeenCalled();
    });

    it('debería manejar errores de ejecución del workflow', async () => {
      // Reset client to ensure fresh initialization
      (workflowService as any).client = null;
      (workflowService as any).connection = null;
      
      mockClient.workflow.start.mockRejectedValueOnce(new Error('Workflow execution failed'));

      const result = await workflowService.scheduleCustomerSupport(mockScheduleParams);

      expect(result).toEqual({
        success: false,
        error: {
          code: 'WORKFLOW_EXECUTION_ERROR',
          message: 'Workflow execution failed'
        }
      });
    });

    it('debería usar opciones personalizadas de workflow', async () => {
      const customOptions = {
        taskQueue: 'customer-support-queue',
        workflowId: 'custom-support-workflow-id'
      };

      await workflowService.scheduleCustomerSupport(mockScheduleParams, customOptions);

      expect(mockClient.workflow.start).toHaveBeenCalledWith('scheduleCustomerSupportMessagesWorkflow', {
        args: [mockScheduleParams],
        taskQueue: 'customer-support-queue',
        workflowId: 'custom-support-workflow-id'
      });
    });
  });
}); 