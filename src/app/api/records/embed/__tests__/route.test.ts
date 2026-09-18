import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { processRecordEmbeddingsById } from '@/lib/services/record-embedding-worker';
import { POST } from '../route';

jest.mock('@/lib/services/record-embedding-worker', () => ({
  processRecordEmbeddingsById: jest.fn(),
}));

const recordId = '00000000-0000-4000-8000-000000000100';

function request(body: unknown, apiKey?: string) {
  return new Request('http://localhost/api/records/embed', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { 'x-api-key': apiKey } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe('record embedding API route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    process.env.SERVICE_API_KEY = 'service-key';
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects requests without the service API key', async () => {
    const response = await POST(request({ record_id: recordId }));

    expect(response.status).toBe(401);
    expect(processRecordEmbeddingsById).not.toHaveBeenCalled();
  });

  it('validates input before processing', async () => {
    const response = await POST(request(
      { record_id: 'not-a-uuid' },
      'service-key',
    ));

    expect(response.status).toBe(400);
    expect(processRecordEmbeddingsById).not.toHaveBeenCalled();
  });

  it('processes valid internal requests', async () => {
    jest.mocked(processRecordEmbeddingsById).mockResolvedValue({
      processedJobs: 1,
      processedNodes: 2,
      remainingNodes: 0,
      stale: false,
    });

    const response = await POST(request({ record_id: recordId }, 'service-key'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      processedJobs: 1,
    });
  });
});
