import { randomBytes, randomUUID } from 'node:crypto';
import { createRedactor } from '@/lib/harness/security';
const upsert = jest.fn();
const from = jest.fn((..._args: any[]) => ({ upsert }));
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: (...args: any[]) => from(...args) } }));
import { writeRequirementInstanceLog } from '../requirement-instance-log';

beforeEach(() => { jest.clearAllMocks(); upsert.mockResolvedValue({ error: null }); });
const run = () => ({ siteId: randomUUID(), userId: randomUUID(), instanceId: randomUUID(), requirementId: randomUUID(),
  sessionId: randomUUID(), runId: randomUUID(), executionGeneration: 3 });

test('writes idempotent instance-scoped audit with trusted host provenance, never a user action', async () => {
  const scope = run();
  const event = { key: 'tool-result:one', log_type: 'tool_result', message: 'Tool finished.',
    details: { session_id: 'forged', run_id: 'forged' } };
  await writeRequirementInstanceLog(scope, event);
  await writeRequirementInstanceLog({ ...scope, runId: randomUUID() }, event);
  expect(from).toHaveBeenCalledWith('instance_logs');
  expect(upsert.mock.calls[0][0]).toMatchObject({ instance_id: scope.instanceId, site_id: scope.siteId,
    trusted_user_action: false, details: { session_id: scope.sessionId, run_id: scope.runId } });
  expect(upsert.mock.calls[1][0].id).toBe(upsert.mock.calls[0][0].id);
  expect(upsert.mock.calls[0][1]).toEqual({ onConflict: 'id', ignoreDuplicates: true });
});

test('redacts sensitive text and nested receipts before writing', async () => {
  const secret = randomBytes(32).toString('hex');
  const url = new URL('https://example.test/private');
  url.username = 'test'; url.password = secret;
  await writeRequirementInstanceLog(run(), { key: 'redaction', log_type: 'error',
    message: secret, tool_args: { url: url.toString() }, tool_result: { nested: [secret] } }, createRedactor([secret]));
  expect(JSON.stringify(upsert.mock.calls)).not.toContain(secret);
});

test('failed write is fatal, without provider/effect retries or raw database errors', async () => {
  upsert.mockResolvedValue({ error: { message: 'private database payload' } });
  await expect(writeRequirementInstanceLog(run(), { key: 'failure', log_type: 'error', message: 'Stopped' }))
    .rejects.toMatchObject({ name: 'RecoveryError', message: 'Instance execution audit persistence unavailable' });
  expect(upsert).toHaveBeenCalledTimes(1);
});