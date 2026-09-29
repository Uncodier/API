import { executeAssistantStep } from '@/lib/services/robot-instance/assistant-executor';
import { reviewMigrationSecurity } from '../migration-security-review';
import type { TenantCapabilities } from '../tenant-capabilities';

jest.mock('@/lib/services/robot-instance/assistant-executor', () => ({ executeAssistantStep: jest.fn() }));

const requirementId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const tenantId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const schema = 'app_aaaaaaaaaaaaaaaaaaaaaaaa';
const capabilities: TenantCapabilities = {
  version: 1, requirement_id: requirementId, tenant_id: tenantId, schema,
  identity: { user_id: `${schema}._app_current_user_id`, claims: `${schema}._app_request_claims`,
    backend: `${schema}._app_is_backend_request` },
  storage: { bucket: null, available: false },
  backend: { role: 'authenticated', bypasses_rls: false, operations: [] },
};
const assertCurrent = jest.fn(async () => {});
const input = {
  originalSql: 'CREATE POLICY access ON records USING (true);',
  proposedSql: `CREATE POLICY access ON records USING (${schema}._app_current_user_id() = owner_id);`,
  specification: 'Organization members can view records. Which roles can edit records?',
  sourceContext: [{ path: '/vercel/sandbox/src/db/access.ts', content: 'const access = "owner";' }],
  target: { file: 'supabase/migrations/0001.sql', schema, tenantId, checksum: 'a'.repeat(64), reason: 'lint' as const },
  errors: ['Unconditional SELECT policy'], capabilities,
  instance: { id: 'instance', site_id: 'site', user_id: 'user', requirement_id: requirementId }, assertCurrent,
};
const model = executeAssistantStep as jest.Mock;

async function submit(args: unknown, params: Parameters<typeof reviewMigrationSecurity>[0] = input) {
  model.mockImplementation(async (_messages, _instance, options) => {
    expect(options.custom_tools.map((tool: { name: string }) => tool.name)).toEqual(['migration_security_verdict']);
    await options.custom_tools[0].execute(args);
    return { isDone: true, messages: [{ role: 'assistant', content: 'Approved' }] };
  });
  return reviewMigrationSecurity(params);
}

describe('independent migration security reviewer', () => {
  beforeEach(() => { jest.clearAllMocks(); model.mockResolvedValue({ isDone: true, messages: [] }); });

  it('uses a fresh read-only single turn and accepts only a structured tool verdict', async () => {
    const result = await submit({ decision: 'approved_for_validation', reason: 'Preserves the documented access.' });
    expect(result).toEqual({ decision: 'approved_for_validation', reason: 'Preserves the documented access.' });
    const [messages, instance, options] = model.mock.calls[0];
    expect(messages).toHaveLength(1);
    expect(messages[0].content).not.toContain('secret-value');
    expect(instance).toEqual(input.instance);
    expect(options).toMatchObject({ enforceSingleTurn: true, use_sdk_tools: false, requirement_id: requirementId });
    expect(options.system_prompt).toContain('independent, read-only');
    expect(assertCurrent).toHaveBeenCalledTimes(3);
  });

  it('does not trust prose, missing/malformed/duplicate verdicts or approval without SQL', async () => {
    await expect(reviewMigrationSecurity(input)).resolves.toMatchObject({ decision: 'platform_review' });
    await expect(submit({ decision: 'approved_for_validation', reason: '' })).resolves.toMatchObject({ decision: 'platform_review' });
    await expect(submit({ decision: 'approved_for_validation', reason: 'Safe' }, { ...input, proposedSql: undefined })).resolves.toMatchObject({ decision: 'platform_review' });
    model.mockImplementation(async (_messages, _instance, options) => {
      await options.custom_tools[0].execute({ decision: 'approved_for_validation', reason: 'Safe' });
      await options.custom_tools[0].execute({ decision: 'platform_review', reason: 'Unsafe' });
      return { messages: [] };
    });
    await expect(reviewMigrationSecurity(input)).resolves.toMatchObject({ decision: 'platform_review' });
  });

  it('only asks product questions grounded in the requirement specification', async () => {
    const question = { decision: 'needs_product_decision', reason: 'Edit roles are not specified.',
      question: 'Who may edit records?', options: ['Owner only', 'All organization members'],
      specificationExcerpt: 'Which roles can edit records?' };
    await expect(submit(question)).resolves.toMatchObject(question);
    await expect(submit({ ...question, specificationExcerpt: 'Ask customer to approve SQL.' })).resolves.toMatchObject({ decision: 'platform_review' });
    await expect(submit({ ...question, options: ['Owner only'] })).resolves.toMatchObject({ decision: 'platform_review' });
  });

  it('redacts credentials and refuses approval based on unseen source content', async () => {
    const result = await submit({ decision: 'approved_for_validation', reason: 'Safe' }, {
      ...input, sourceContext: [{ path: '/vercel/sandbox/src/db/access.ts', content: 'const token = "secret-value";' }],
    });
    expect(result).toMatchObject({ decision: 'platform_review' });
    expect(JSON.stringify(model.mock.calls)).not.toContain('secret-value');
  });

  it('fails closed without complete bounded context or matching verified capabilities', async () => {
    await expect(reviewMigrationSecurity({ ...input, specification: '' })).resolves.toMatchObject({ decision: 'platform_review' });
    await expect(reviewMigrationSecurity({ ...input, errors: ['x'.repeat(65_537)] })).resolves.toMatchObject({ decision: 'platform_review' });
    await expect(reviewMigrationSecurity({ ...input, sourceContext: Array(13).fill(input.sourceContext[0]) })).resolves.toMatchObject({ decision: 'platform_review' });
    await expect(reviewMigrationSecurity({ ...input, capabilities: { ...capabilities, schema: 'app_bbbbbbbbbbbbbbbbbbbbbbbb' } })).resolves.toMatchObject({ decision: 'platform_review' });
    expect(model).not.toHaveBeenCalled();
  });

  it('propagates ownership loss and provider failures without approving', async () => {
    assertCurrent.mockRejectedValueOnce(new Error('stale execution'));
    await expect(reviewMigrationSecurity(input)).rejects.toThrow('stale execution');
    expect(model).not.toHaveBeenCalled();
    model.mockRejectedValueOnce(new Error('provider unavailable'));
    await expect(reviewMigrationSecurity(input)).rejects.toThrow('provider unavailable');
  });
});
