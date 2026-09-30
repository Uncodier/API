import { executeAssistantStep } from '@/lib/services/robot-instance/assistant-executor';
import { reviewMigrationSecurity, type MigrationProductDecision } from '../migration-security-review';
import { lintMigration } from '../migration-linter';
import * as repairPolicy from '../migration-repair-policy';
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

const applicationSql = `
  CREATE TABLE ${schema}.records (id uuid PRIMARY KEY, owner_id uuid NOT NULL, title text);
  ALTER TABLE ${schema}.records ENABLE ROW LEVEL SECURITY;
  CREATE POLICY access ON ${schema}.records FOR SELECT TO authenticated
    USING (owner_id = ${schema}._app_current_user_id());
  CREATE INDEX records_owner_idx ON ${schema}.records (owner_id);
`;
const approval = { decision: 'approved_for_validation', reason: 'Preserves the documented access.' };
const applicationInput = {
  ...input, reviewMode: 'application' as const,
  originalSql: applicationSql, proposedSql: applicationSql,
  specification: 'Each record has an id, owner and title. Only the owner may read it.',
  target: { ...input.target, file: 'platform/0001.records.sql' }, sourceContext: [], errors: [],
};

describe('independent migration security reviewer', () => {
  beforeEach(() => { jest.clearAllMocks(); model.mockResolvedValue({ isDone: true, messages: [] }); });
  afterEach(() => { jest.restoreAllMocks(); });

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

  it('only asks product questions bound to a pending host record and the requirement specification', async () => {
    const question = { decision: 'needs_product_decision', decisionId: 'record-editors', reason: 'Edit roles are not specified.',
      question: 'Who may edit records?', options: ['Owner only', 'All organization members'],
      specificationExcerpt: 'Which roles can edit records?' };
    const decision: MigrationProductDecision = { id: question.decisionId, kind: 'access_audience', status: 'pending',
      question: question.question, options: question.options, specificationExcerpt: question.specificationExcerpt };
    const trustedInput = { ...input, productDecisions: [decision] };
    await expect(submit(question, trustedInput)).resolves.toEqual(question);
    await expect(submit(question)).resolves.toMatchObject({ decision: 'platform_review' });
    await expect(submit({ ...question, specificationExcerpt: 'Ask customer to approve SQL.' })).resolves.toMatchObject({ decision: 'platform_review' });
    await expect(submit({ ...question, options: ['Owner only'] }, trustedInput)).resolves.toMatchObject({ decision: 'platform_review' });
    await expect(submit({ ...question, question: 'Authorize SQL rewrite?', options: ['Yes', 'No'] }, trustedInput))
      .resolves.toMatchObject({ decision: 'platform_review' });
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

  describe('central application review', () => {
    it('accepts a lint-clean new tenant schema migration without using the policy-replacement checker', async () => {
      expect(lintMigration({ sql: applicationSql, schema, tenant_id: tenantId }).ok).toBe(true);
      const replacementCheck = jest.spyOn(repairPolicy, 'canAutomaticallyReplaceMigration').mockReturnValue(false);
      await expect(submit(approval, applicationInput)).resolves.toEqual(approval);
      expect(replacementCheck).not.toHaveBeenCalled();
      const [messages, , options] = model.mock.calls[0];
      expect(messages[0].content).toContain('"reviewMode":"application"');
      expect(messages[0].content).toContain('"canApprove":true');
      expect(options.system_prompt).toContain('NOT permission to edit applied migration history');
      expect(options.system_prompt).toContain('static tenant-local schema creation');
    });

    it('accepts rewritten pending SQL even when the original cannot be automatically policy-repaired', async () => {
      const originalSql = `DO $$ BEGIN EXECUTE 'CREATE TABLE records(id uuid)'; END $$;`;
      expect(repairPolicy.canAutomaticallyReplaceMigration(originalSql, applicationSql)).toBe(false);
      await expect(submit(approval, { ...applicationInput, originalSql })).resolves.toEqual(approval);
    });

    it('keeps default and explicit policy repair constrained even when capabilities exist', async () => {
      const proposedSql = `${input.proposedSql}\nALTER TABLE records ADD COLUMN title text;`;
      await expect(submit(approval, { ...input, proposedSql })).resolves.toMatchObject({ decision: 'platform_review' });
      await expect(submit(approval, { ...input, proposedSql, reviewMode: 'policy_repair' })).resolves.toMatchObject({ decision: 'platform_review' });
      await expect(submit(approval, { ...input, proposedSql, reviewMode: 'application' })).resolves.toEqual(approval);
    });

    it.each([
      ['absent proposal', { proposedSql: undefined }], ['empty proposal', { proposedSql: ' \n ' }],
      ['absent capabilities', { capabilities: undefined }],
      ['mismatched tenant', { capabilities: { ...capabilities, tenant_id: 'other' } }],
      ['mismatched requirement', { capabilities: { ...capabilities, requirement_id: 'other' } }],
      ['mismatched schema', { capabilities: { ...capabilities, schema: 'app_bbbbbbbbbbbbbbbbbbbbbbbb' } }],
      ['invented identity', { capabilities: { ...capabilities, identity: { ...capabilities.identity, user_id: 'auth.uid' } } }],
      ['bypass RLS', { capabilities: { ...capabilities, backend: { ...capabilities.backend, bypasses_rls: true } } }],
      ['unregistered RPC', { capabilities: { ...capabilities, backend: { ...capabilities.backend, operations: ['do_anything'] } } }],
      ['unknown mode', { reviewMode: 'automatic' }],
    ])('fails closed before a model call for %s', async (_label, invalid) => {
      await expect(reviewMigrationSecurity({ ...applicationInput, ...invalid } as Parameters<typeof reviewMigrationSecurity>[0]))
        .resolves.toMatchObject({ decision: 'platform_review' });
      expect(model).not.toHaveBeenCalled();
    });

    it.each(['platform/../0001.sql', 'platform/a..b.sql', 'platform/nested/0001.sql', 'platform/.hidden.sql'])
      ('rejects unsafe platform migration path %s', async file => {
        await expect(reviewMigrationSecurity({ ...applicationInput, target: { ...applicationInput.target, file } }))
          .resolves.toMatchObject({ decision: 'platform_review' });
        expect(model).not.toHaveBeenCalled();
      });

    it('limits platform paths to application mode while supporting ordinary project paths in application mode', async () => {
      await expect(reviewMigrationSecurity({ ...input, target: { ...input.target, file: 'platform/0001.sql' } }))
        .resolves.toMatchObject({ decision: 'platform_review' });
      expect(model).not.toHaveBeenCalled();
      await expect(submit(approval, { ...applicationInput, target: input.target })).resolves.toEqual(approval);
    });

    it.each([
      'UPDATE records SET owner_id = NULL;',
      'DELETE /* marker */ FROM records;',
      'TRUNCATE TABLE records;',
      'DROP TABLE records;',
      'DROP SCHEMA app_aaaaaaaaaaaaaaaaaaaaaaaa CASCADE;',
      'ALTER TABLE records DROP COLUMN title;',
      'ALTER TABLE records DROP title;',
      'ALTER TABLE records DROP CONSTRAINT records_pkey;',
      'ALTER TABLE records ADD COLUMN extra text, DROP owner_id;',
      'WITH removed AS (DELETE FROM records RETURNING *) SELECT * FROM removed;',
      'WITH changed AS (UPDATE records SET title = NULL RETURNING *) SELECT * FROM changed;',
      'MERGE INTO records r USING changes c ON r.id = c.id WHEN MATCHED THEN DELETE;',
      "INSERT INTO records(id) VALUES ('1') ON CONFLICT(id) DO UPDATE SET owner_id = NULL;",
      'CREATE FUNCTION erase_records() RETURNS void LANGUAGE sql AS $$ DELETE FROM records; $$;',
      'DROP POLICY access ON records;',
    ])('rejects destructive application SQL even if the model approves: %s', async sql => {
      await expect(submit(approval, { ...applicationInput, proposedSql: `${applicationSql}\n${sql}` }))
        .resolves.toMatchObject({ decision: 'platform_review' });
    });

    it.each([
      `DO $$ BEGIN EXECUTE 'SELECT 1'; END $$;`,
      'PREPARE hidden AS SELECT 1;', 'EXECUTE hidden;',
      'CALL mutate_records();', 'COPY records TO PROGRAM \'cat\';',
      'GRANT ALL ON records TO anon;', 'ALTER TABLE records DISABLE ROW LEVEL SECURITY;',
      'CREATE TABLE public.escape (id uuid);',
      'CREATE TABLE records_without_rls (id uuid);',
      'CREATE POLICY insecure ON records USING (true);',
      'CREATE FUNCTION hidden() RETURNS void LANGUAGE plpgsql AS $$ BEGIN EXECUTE \'SELECT 1\'; END; $$;',
      "CREATE FUNCTION hidden() RETURNS integer LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1; $$;",
      'ALTER TABLE records ADD COLUMN bad text /* unterminated',
      "SET standard_conforming_strings = off; SELECT 'hidden';",
    ])('rejects dynamic, forbidden or unlintable application SQL: %s', async sql => {
      await expect(submit(approval, { ...applicationInput, proposedSql: `${applicationSql}\n${sql}` }))
        .resolves.toMatchObject({ decision: 'platform_review' });
    });

    it('does not confuse harmless literal/identifier/comment keywords or policy operations with destructive DML', async () => {
      const sql = `${applicationSql}
        ALTER TABLE records ADD COLUMN "drop" text DEFAULT 'UPDATE records SET owner_id = NULL; DROP TABLE records;';
        COMMENT ON TABLE records IS 'TRUNCATE records';
        -- DELETE FROM records;
        CREATE POLICY update_records ON records FOR UPDATE TO authenticated
          USING (owner_id = ${schema}._app_current_user_id()) WITH CHECK (owner_id = ${schema}._app_current_user_id());
        CREATE POLICY delete_records ON records FOR DELETE TO authenticated USING (owner_id = ${schema}._app_current_user_id());
      `;
      expect(lintMigration({ sql, schema, tenant_id: tenantId }).ok).toBe(true);
      await expect(submit(approval, { ...applicationInput, proposedSql: sql })).resolves.toEqual(approval);
    });

    it.each([
      'DROP POLICY IF EXISTS access ON records;',
      `DROP POLICY access ON ${schema}.records RESTRICT;`,
      `DROP POLICY "access" ON "${schema}"."records";`,
    ])('supports idempotent same-identity policy recreation: %s', async drop => {
      const proposedSql = applicationSql.replace('CREATE POLICY access', `${drop}\nCREATE POLICY access`);
      expect(lintMigration({ sql: proposedSql, schema, tenant_id: tenantId }).ok).toBe(true);
      await expect(submit(approval, { ...applicationInput, proposedSql })).resolves.toEqual(approval);
    });

    it.each([
      'DROP POLICY another ON records;', 'DROP POLICY "ACCESS" ON records;',
      'DROP POLICY access ON other_records;', 'DROP POLICY access ON records CASCADE;',
      'DROP POLICY access ON public.records;',
    ])('rejects policy removal without exact subsequent tenant-local recreation: %s', async drop => {
      const proposedSql = applicationSql.replace('CREATE POLICY access', `${drop}\nCREATE POLICY access`);
      await expect(submit(approval, { ...applicationInput, proposedSql })).resolves.toMatchObject({ decision: 'platform_review' });
    });

    it('refuses redacted context and comment-only proposals in application mode', async () => {
      await expect(submit(approval, { ...applicationInput, originalSql: `${applicationSql} -- sk-hidden-original` }))
        .resolves.toMatchObject({ decision: 'platform_review' });
      await expect(submit(approval, { ...applicationInput, proposedSql: '-- no executable SQL' }))
        .resolves.toMatchObject({ decision: 'platform_review' });
    });

    it('does not treat application mode as permission to invent a product decision', async () => {
      await expect(submit({ decision: 'needs_product_decision', decisionId: 'unregistered', reason: 'SQL needs fixing.',
        question: 'Authorize SQL rewrite?', options: ['Yes', 'No'], specificationExcerpt: applicationInput.specification }, applicationInput))
        .resolves.toMatchObject({ decision: 'platform_review' });
    });
  });
});
