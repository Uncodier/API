import { createHash } from 'node:crypto';
import {
  migrationDiagnosisInstructions,
  unresolvedMigration,
  validateMigrationDiagnosis,
  type DiagnosticEvidence,
} from '@/lib/services/apps-platform/migration-diagnostic-policy';
import type { MigrationProductDecision } from '@/lib/services/apps-platform/migration-security-review';
import type { TenantCapabilities } from '@/lib/services/apps-platform/tenant-capabilities';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const schema = 'app_aaaaaaaaaaaaaaaaaaaaaaaa';
const previousInstructions = 'Replace auth.uid() with the verified tenant identity helper.';
const candidate = {
  decision: 'repair_candidate',
  reason: 'The organization membership predicate omits the record organization.',
  evidence_ids: ['migration', 'specification'],
  hypothesis: 'Correlating the membership organization preserves collaboration while rejecting unrelated users.',
  instruction: 'Correlate the protected membership predicate with records.organization_id in the unapplied migration.',
  verification: 'Verify member access, unrelated organization denial, anonymous denial, and rollback.',
  next_action: 'Change the unapplied policy, then run independent security review and authorization tests.',
};

function evidence(id: string, excerpt: string): DiagnosticEvidence {
  return { id, source: `host:${id}`, checksum: digest(excerpt), excerpt };
}

function context() {
  const capabilities: TenantCapabilities = {
    version: 1, requirement_id: 'requirement', tenant_id: 'tenant', schema,
    identity: { user_id: `${schema}._app_current_user_id`, claims: `${schema}._app_request_claims`, backend: `${schema}._app_is_backend_request` },
    storage: { available: false, bucket: null },
    backend: { role: 'authenticated', bypasses_rls: false, operations: [] },
  };
  return {
    evidence: [
      evidence('migration', 'CREATE POLICY members ON records USING (true);'),
      evidence('specification', 'Organization members collaborate; unrelated organizations cannot read records.'),
      evidence('capabilities', JSON.stringify(capabilities)),
      evidence('source-1', 'The application filters records by organization_id.'),
    ],
    capabilities, previousInstructions,
  };
}

describe('host-validated migration diagnostic policy', () => {
  it('accepts a different, testable repair grounded in host migration and specification evidence', () => {
    const host = context();
    const { evidence_ids: _ids, ...fields } = candidate;
    expect(validateMigrationDiagnosis(candidate, host)).toEqual({
      ...fields, evidence: host.evidence.slice(0, 2),
    });
  });

  it.each([
    ['unknown evidence', ['migration', 'specification', 'invented-source']],
    ['duplicate evidence', ['migration', 'specification', 'migration']],
    ['no evidence', []],
    ['no specification', ['migration', 'source-1']],
    ['no migration', ['specification', 'source-1']],
    ['only capability metadata', ['capabilities']],
  ])('refuses repair with %s', (_label, evidence_ids) => {
    expect(validateMigrationDiagnosis({ ...candidate, evidence_ids }, context()).decision).toBe('unresolved');
  });

  it('does not accept model-supplied evidence objects in place of host-collected IDs', () => {
    expect(validateMigrationDiagnosis({ ...candidate, evidence: context().evidence }, context()).decision).toBe('unresolved');
  });

  it('rejects ambiguous duplicate host IDs even when their count conceals an unknown cited ID', () => {
    const host = context();
    host.evidence.push({ ...host.evidence[0], source: 'another migration', excerpt: 'A different migration.' });
    expect(validateMigrationDiagnosis({ ...candidate, evidence_ids: ['migration', 'specification', 'not-collected'] }, host).decision)
      .toBe('unresolved');
  });

  it.each([
    { checksum: 'not-a-checksum' }, { source: '' }, { source: 's'.repeat(513) },
    { excerpt: '' }, { excerpt: 'e'.repeat(1601) },
  ])('refuses malformed collected evidence rather than retaining it: %j', invalid => {
    const host = context();
    host.evidence[0] = { ...host.evidence[0], ...invalid };
    expect(validateMigrationDiagnosis(candidate, host).decision).toBe('unresolved');
  });

  it.each(['hypothesis', 'instruction', 'verification'])('requires a concrete %s for a repair candidate', field => {
    const value: Record<string, unknown> = { ...candidate };
    delete value[field];
    expect(validateMigrationDiagnosis(value, context()).decision).toBe('unresolved');
    expect(validateMigrationDiagnosis({ ...candidate, [field]: '  ' }, context()).decision).toBe('unresolved');
  });

  it.each([previousInstructions, `  ${previousInstructions}\n`])('refuses the exhausted unchanged instruction: %s', instruction => {
    const result = validateMigrationDiagnosis({ ...candidate, instruction }, context());
    expect(result.decision).toBe('unresolved');
    expect(result.reason).toMatch(/different|previous|unchanged/i);
  });

  it.each([
    undefined, null, 'Repair is impossible.', JSON.stringify(candidate), [],
    { ...candidate, decision: 'irreparable' },
    { ...candidate, decision: 'approved_for_validation' },
    { ...candidate, approved: true },
    { ...candidate, reason: '' },
    { ...candidate, reason: 'r'.repeat(1201) },
    { ...candidate, instruction: 'i'.repeat(3501) },
    { ...candidate, evidence_ids: Array.from({ length: 13 }, (_, index) => `source-${index}`) },
  ])('maps invalid or prose-only verdicts to unresolved, not irreparable (%#)', value => {
    const result = validateMigrationDiagnosis(value, context());
    expect(result).toMatchObject({ decision: 'unresolved', evidence: [] });
    expect(result.next_action).toMatch(/not proof.*impossible/i);
  });

  it.each([
    'Bearer synthetic-access-value', 'sb_secret_synthetic_value', 'ghp_synthetic_value',
    'sk-synthetic-value', 'eyJhbGciOiJIUzI1NiJ9.payload.signature',
    '-----BEGIN PRIVATE KEY-----\nsynthetic-material\n-----END PRIVATE KEY-----',
    'const password = "synthetic-quoted-password";',
  ])('does not retain sensitive model text: %s', secret => {
    const result = validateMigrationDiagnosis({ ...candidate, reason: `Failure included ${secret}` }, context());
    expect(result.decision).toBe('unresolved');
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  describe('verified capability gaps', () => {
    const missing = {
      decision: 'missing_capability', reason: 'The verified manifest does not provision storage.',
      evidence_ids: ['capabilities'], capability: 'storage',
      next_action: 'Ask the platform to verify and provision the required tenant storage capability.',
    };

    it('accepts missing storage only when storage.available is false in the actual host manifest', () => {
      expect(validateMigrationDiagnosis(missing, context())).toMatchObject({ decision: 'missing_capability', capability: 'storage' });
      const host = context();
      host.capabilities.storage = { available: true, bucket: 'tenant-records' };
      // A stale excerpt/model claim does not override the current manifest object.
      expect(validateMigrationDiagnosis(missing, host).decision).toBe('unresolved');
    });

    it.each([
      { evidence_ids: ['specification'] }, { capability: undefined }, { capability: 'service_role' },
    ])('rejects an unverified capability claim: %j', invalid => {
      expect(validateMigrationDiagnosis({ ...missing, ...invalid }, context()).decision).toBe('unresolved');
    });

    it.each([undefined, null, 0, 'false'])('requires literal false, not absent or malformed availability (%j)', available => {
      const host = context();
      host.capabilities.storage.available = available as unknown as boolean;
      expect(validateMigrationDiagnosis(missing, host).decision).toBe('unresolved');
    });
  });

  describe('canonical product choices', () => {
    const choice: MigrationProductDecision = {
      id: 'record-audience', kind: 'access_audience', status: 'pending',
      question: 'Should records be private or shared with organization members?',
      options: ['Only the creator', 'Organization members'],
      specificationExcerpt: 'The audience has not yet been chosen.',
    };
    const proposal = {
      decision: 'needs_product_decision', decision_id: choice.id, question: choice.question,
      options: choice.options, evidence_ids: ['specification'],
      reason: 'The host has an unresolved audience choice.', next_action: 'Resolve the recorded audience choice.',
    };

    it('rejects a model-invented product decision without a matching host record', () => {
      const result = validateMigrationDiagnosis(proposal, context());
      expect(result.decision).toBe('unresolved');
      expect(result.reason).toMatch(/canonical product decision/i);
    });

    it('accepts only the exact pending host question and options', () => {
      expect(validateMigrationDiagnosis(proposal, { ...context(), productDecisions: [choice] }).decision)
        .toBe('needs_product_decision');
    });

    it.each([
      { decision_id: 'invented' }, { question: 'May I repair and apply the SQL?' },
      { options: ['Yes', 'No'] }, { options: [...choice.options].reverse() },
    ])('rejects a changed or generic approval question even with a real record: %j', invalid => {
      expect(validateMigrationDiagnosis({ ...proposal, ...invalid }, { ...context(), productDecisions: [choice] }).decision)
        .toBe('unresolved');
    });

    it.each(['apply it', 'repair it', 'yes, do whatever is needed'])('does not treat "%s" as permission to change scope or bypass validation', reply => {
      const host = context();
      host.evidence[1] = evidence('specification', reply);
      host.previousInstructions = reply;
      const result = validateMigrationDiagnosis({ ...proposal, question: 'May I apply the SQL?', options: ['Yes', 'No'] }, host);
      expect(result.decision).toBe('unresolved');
      expect(result.reason).toMatch(/generic repair\/apply approval cannot authorize/i);
    });
  });

  describe('constraint conflict, not universal impossibility', () => {
    const conflict = {
      decision: 'constraint_conflict', reason: 'The requirement needs uploads but current tenant storage is unavailable.',
      evidence_ids: ['specification', 'capabilities'],
      alternatives: ['Provision tenant storage, then validate uploads.', 'Record a product decision to defer uploads.'],
      next_action: 'Verify the storage provisioning path without weakening authorization.',
    };

    it('allows a bounded conflict with both verified constraints and concrete alternatives', () => {
      expect(validateMigrationDiagnosis(conflict, context())).toMatchObject({
        decision: 'constraint_conflict', alternatives: conflict.alternatives,
      });
    });

    it.each([
      { evidence_ids: ['specification'] }, { evidence_ids: ['capabilities'] },
      { evidence_ids: ['migration'] }, { alternatives: undefined }, { alternatives: [] }, { alternatives: ['  '] },
    ])('does not infer impossibility from exhaustion or insufficient conflict evidence: %j', invalid => {
      expect(validateMigrationDiagnosis({ ...conflict, ...invalid }, context()).decision).toBe('unresolved');
    });
  });

  it('renders a candidate as one constrained follow-up, never an approval or fresh retry budget', () => {
    const diagnosis = validateMigrationDiagnosis(candidate, context());
    const instructions = migrationDiagnosisInstructions(diagnosis);
    expect(instructions).toContain(candidate.hypothesis);
    expect(instructions).toContain(candidate.instruction);
    expect(instructions).toContain(candidate.verification);
    expect(instructions).toContain(JSON.stringify(diagnosis.evidence));
    expect(instructions).toMatch(/not a fresh retry budget/);
    expect(instructions).toMatch(/Only modify the verified unapplied migration/);
    expect(instructions).toMatch(/Do not weaken RLS/);
    expect(instructions).toMatch(/sandbox_db_migrate/);
    expect(instructions).toMatch(/fresh authorization and product tests remain mandatory/);
  });

  it.each(['unresolved', 'missing_capability', 'needs_product_decision', 'constraint_conflict'] as const)
  ('does not produce repair instructions for %s', decision => {
    expect(() => migrationDiagnosisInstructions({ ...unresolvedMigration('Needs investigation.'), decision })).toThrow(/No diagnostic repair candidate/);
  });

  it('keeps exhaustion unresolved with an explicit next check and no generic permission request', () => {
    const result = unresolvedMigration('The three diagnostic calls produced no new evidence.');
    expect(result).toMatchObject({ decision: 'unresolved', evidence: [], reason: 'The three diagnostic calls produced no new evidence.' });
    expect(result.next_action).toMatch(/new evidence or a changed verified capability/);
    expect(result.next_action).toMatch(/not proof.*impossible/i);
    expect(result.next_action).toMatch(/Do not repeat.*or request generic approval/);
  });
});