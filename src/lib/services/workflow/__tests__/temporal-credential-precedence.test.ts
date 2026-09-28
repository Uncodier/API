// @ts-nocheck -- Dynamic ESM Jest mocks under the project's ES5 TS target.
import { jest } from '@jest/globals';

const connect = jest.fn(async () => ({ close: jest.fn(async () => undefined) }));
const start = jest.fn(async () => ({ workflowId: 'workflow-1', firstExecutionRunId: 'run-1' }));
const client = jest.fn(() => ({ workflow: { start } }));

jest.unstable_mockModule('@temporalio/client', () => ({
  Connection: { connect },
  Client: client,
}));

const { BaseWorkflowService } = await import('../base-workflow-service');

class TestWorkflowService extends BaseWorkflowService {
  async connectForTest() {
    return this.initializeClient();
  }
}

const original = {
  TEMPORAL_SERVER_URL: process.env.TEMPORAL_SERVER_URL,
  TEMPORAL_GATEWAY_SERVICE_API_KEY: process.env.TEMPORAL_GATEWAY_SERVICE_API_KEY,
  TEMPORAL_SERVICE_API_KEY: process.env.TEMPORAL_SERVICE_API_KEY,
  TEMPORAL_CLOUD_API_KEY: process.env.TEMPORAL_CLOUD_API_KEY,
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env.TEMPORAL_SERVER_URL = 'primary.tmprl.cloud:7233';
  process.env.TEMPORAL_GATEWAY_SERVICE_API_KEY = 'azure-write-key';
  process.env.TEMPORAL_SERVICE_API_KEY = 'legacy-read-only-key';
  process.env.TEMPORAL_CLOUD_API_KEY = 'legacy-read-only-key';
});

afterAll(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

it('prefers the gateway service key for workflow starts over legacy keys', async () => {
  const service = new TestWorkflowService();
  const temporal = await service.connectForTest();

  expect(service.getTemporalConfig().deploymentType).toBe('cloud');
  expect(connect).toHaveBeenCalledWith(expect.objectContaining({
    address: 'primary.tmprl.cloud:7233',
    tls: expect.any(Object),
    metadata: {
      'temporal-namespace': 'default',
      authorization: 'Bearer azure-write-key',
    },
  }));
  await temporal.workflow.start('customerSupportMessageWorkflow', {
    args: [{ message: 'Hello' }], workflowId: 'workflow-1', taskQueue: 'high',
  });
  expect(start).toHaveBeenCalledWith('customerSupportMessageWorkflow', expect.objectContaining({
    workflowId: 'workflow-1', taskQueue: 'high',
  }));
});

it('falls back to the service key when the gateway key is not set', async () => {
  delete process.env.TEMPORAL_GATEWAY_SERVICE_API_KEY;
  const service = new TestWorkflowService();

  expect(service.getTemporalConfig().isConfigured).toBe(true);
  await service.connectForTest();
  expect(connect).toHaveBeenCalledWith(expect.objectContaining({
    address: 'primary.tmprl.cloud:7233',
    metadata: expect.objectContaining({ authorization: 'Bearer legacy-read-only-key' }),
  }));
});

it('falls back to the cloud key when both gateway and service keys are unavailable', async () => {
  process.env.TEMPORAL_GATEWAY_SERVICE_API_KEY = '   ';
  delete process.env.TEMPORAL_SERVICE_API_KEY;
  process.env.TEMPORAL_CLOUD_API_KEY = 'cloud-fallback-key';
  const service = new TestWorkflowService();

  await service.connectForTest();
  expect(connect).toHaveBeenCalledWith(expect.objectContaining({
    metadata: expect.objectContaining({ authorization: 'Bearer cloud-fallback-key' }),
  }));
});

it('prefers the gateway key for another Temporal Cloud endpoint without a hard-coded host', async () => {
  process.env.TEMPORAL_SERVER_URL = 'tenant.tmprl.cloud:7233';
  const service = new TestWorkflowService();

  await service.connectForTest();
  expect(connect).toHaveBeenCalledWith(expect.objectContaining({
    address: 'tenant.tmprl.cloud:7233',
    metadata: expect.objectContaining({ authorization: 'Bearer azure-write-key' }),
  }));
});

it('keeps local Temporal connections unauthenticated', async () => {
  process.env.TEMPORAL_SERVER_URL = 'localhost:7233';
  const service = new TestWorkflowService();

  await service.connectForTest();
  expect(connect).toHaveBeenCalledWith(expect.objectContaining({ address: 'localhost:7233' }));
  expect(connect.mock.calls[0][0].metadata).toBeUndefined();
});