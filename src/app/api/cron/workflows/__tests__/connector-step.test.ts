import { jest, expect, it, beforeEach, afterAll } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { executeScheduledConnectorStep } from '../connector-step';
import { runWorkflowConnectorRead } from '@/lib/connectors/workflow-read';
import { supabaseAdmin } from '@/lib/database/supabase-client';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { rpc: jest.fn() } }));
jest.mock('@/lib/connectors/workflow-read', () => ({ runWorkflowConnectorRead: jest.fn() }));
const job = { run_id: randomUUID(), job_id: randomUUID() };
const keys = { p_run: job.run_id, p_job: job.job_id };
const privateResult = {executed:true as const, report:{title:'Connector result',note:'Private preview',columns:['Field','Value'],rows:[['$.name','Blue item']]}};
const binding = { connector_id: 'bound', credential_revision: 'r1' };
const rpc = jest.mocked(supabaseAdmin.rpc);
const read = jest.mocked(runWorkflowConnectorRead);
const result = (data: unknown, error?: { code: string }) => ({ abortSignal: () => Promise.resolve({ data, error }) }) as never;
const originalFlag = process.env.WORKFLOW_CONNECTOR_READS_ENABLED;
beforeEach(() => { jest.resetAllMocks(); process.env.WORKFLOW_CONNECTOR_READS_ENABLED = 'true'; });
afterAll(() => { if (originalFlag === undefined) delete process.env.WORKFLOW_CONNECTOR_READS_ENABLED; else process.env.WORKFLOW_CONNECTOR_READS_ENABLED = originalFlag; });

it('prepares an already reserved run after a queue delay, without recreating or timing the occurrence', async () => {
  const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_600_000);
  try {
    rpc.mockReturnValueOnce(result(binding)).mockReturnValueOnce(result({ ...binding })).mockReturnValueOnce(result(true));
    read.mockImplementation(async (_, gate) => { await gate(); return privateResult; });
    expect(await executeScheduledConnectorStep(job)).toBe('completed');
    expect(rpc.mock.calls).toEqual([['workflow_connector_prepare', keys],
      ['workflow_connector_dispatch', keys], ['workflow_connector_finish', { ...keys, p_result: privateResult }]]);
    expect(executeScheduledConnectorStep.maxRetries).toBe(0);
  } finally { clock.mockRestore(); }
});

it('blocks replay of old job shapes, disabled workers and jobs without DB authority', async () => {
  expect(await executeScheduledConnectorStep({ ...job, trigger: randomUUID() } as typeof job)).toBe('blocked');
  delete process.env.WORKFLOW_CONNECTOR_READS_ENABLED;
  expect(await executeScheduledConnectorStep(job)).toBe('blocked');
  expect(rpc).not.toHaveBeenCalled();
  process.env.WORKFLOW_CONNECTOR_READS_ENABLED = 'true';
  rpc.mockReturnValueOnce(result(null, { code: '42501' }));
  expect(await executeScheduledConnectorStep(job)).toBe('blocked');
  expect(read).not.toHaveBeenCalled();
});

it('does not dispatch after disabling or finish after binding drift', async () => {
  rpc.mockReturnValueOnce(result(binding));
  read.mockImplementationOnce(async (_, gate) => { delete process.env.WORKFLOW_CONNECTOR_READS_ENABLED; await gate(); return privateResult; });
  await expect(executeScheduledConnectorStep(job)).rejects.toThrow('could not be confirmed');
  expect(rpc.mock.calls).toEqual([['workflow_connector_prepare', keys]]);
  process.env.WORKFLOW_CONNECTOR_READS_ENABLED = 'true';
  rpc.mockReturnValueOnce(result(binding)).mockReturnValueOnce(result({ ...binding, credential_revision: 'r2' }));
  read.mockImplementation(async (_, gate) => { await gate(); return privateResult; });
  await expect(executeScheduledConnectorStep(job)).rejects.toThrow('could not be confirmed');
  expect(rpc).toHaveBeenCalledTimes(3);
});
