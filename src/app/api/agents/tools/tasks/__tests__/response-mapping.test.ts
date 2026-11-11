import { getCustomToolDefinition } from '@/lib/agentbase/agents/toolEvaluator/executor/customToolsMap';
import { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { POST } from '../get/route';
import { getTasks, getTaskStats } from '@/lib/database/task-db';

jest.mock('@/lib/database/task-db', () => ({ getTasks: jest.fn(), getTaskStats: jest.fn() }));

function map(name: string, response: Record<string, unknown>) {
  const mapping = getCustomToolDefinition(name)!.responseMapping;
  return Object.fromEntries(Object.entries(mapping).map(([key, path]) => [
    key, path.split('.').reduce<any>((value, part) => value?.[part], response),
  ]));
}

// Workflows apiService returns an existing success/data envelope unchanged;
// executeToolActivities then passes response.data into processResponse.
function localWorkerResult(name: string, httpBody: Record<string, any>) {
  const apiResponse = 'success' in httpBody && 'data' in httpBody
    ? httpBody : { success: true, data: httpBody };
  return map(name, apiResponse.data);
}

it('preserves a real GET_TASKS HTTP response through local apiService unwrapping and response mapping', async () => {
  const tasks = [{ id: 'task-1', title: 'Verify pending results', status: 'pending' }];
  (getTasks as jest.Mock).mockResolvedValue({ tasks, total: 2, hasMore: true });
  (getTaskStats as jest.Mock).mockResolvedValue({ total: 2 });
  const response = await POST(new NextRequest('https://api.example.test/api/agents/tools/tasks/get', {
    method: 'POST', body: JSON.stringify({ site_id: randomUUID(), lead_id: randomUUID(), limit: 1 }),
  }));
  expect(response.status).toBe(200);
  const pagination = { total: 2, count: 1, limit: 1, offset: 0, has_more: true };
  expect(localWorkerResult('GET_TASKS', await response.json())).toEqual({
    success: true, tasks, pagination, total_tasks: 2, count: 1, limit: 1, offset: 0, has_more: true,
  });
});

it('preserves existing task information when CREATE_TASK reuses a task', () => {
  const existing = {
    id: 'task-1', description: 'Verify study 42 and deliver results', notes: 'Promised before noon',
    assignee: randomUUID(), conversation_id: randomUUID(), updated_at: '2026-11-11T00:00:00Z',
    completed_date: null,
  };
  expect(localWorkerResult('CREATE_TASK', {
    success: true, created: false, deduplicated: true,
    task: existing, message: 'Use UPDATE_TASK',
  })).toMatchObject({ ...existing, success: true, created: false, deduplicated: true, message: 'Use UPDATE_TASK' });
});