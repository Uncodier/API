import { loadRuntimeModule } from '@/lib/custom-automation/test-helpers/load-runtime-module';
import type { CronExecutionOwnership } from '../cron-execution-ownership';

const billingNotice = {
  message: 'Tus créditos se han agotado para continuar este ciclo. Reinicio: 1 de noviembre de 2026.',
  nextResetAt: '2026-11-01T00:00:00.000Z',
  available: 0,
};
const visibleNotice = {
  ...billingNotice,
  message: `${billingNotice.message} El ciclo se ha pausado; el trabajo pendiente no se ha marcado como completado. Puedes reanudar cuando dispongas de créditos.`,
};
const fallbackMessage = 'Tus créditos se han agotado para continuar este ciclo. La próxima fecha de reinicio no está disponible. El trabajo pendiente no se ha marcado como completado. Puedes añadir créditos o reanudar cuando se renueven.';
const params = {
  instanceId: 'instance-1', siteId: 'site-1', userId: 'user-1',
  eventId: 'cycle-1:credits_exhausted',
  planId: 'plan-1', stepId: 'step-1', requirementId: 'requirement-1',
};
const billingErrors = loadRuntimeModule<typeof import('@/lib/services/billing/credit-exhaustion-message')>(
  'src/lib/services/billing/credit-exhaustion-message.ts', {},
);
const { RecoveryError } = loadRuntimeModule<typeof import('@/lib/services/robot-instance/assistant-recovery-schema')>(
  'src/lib/services/robot-instance/assistant-recovery-schema.ts', {
    './assistant-respawn-policy': { MAX_RESPAWNS: 3 },
  },
);

type Query = {
  table: string;
  operation: 'select' | 'insert' | 'update';
  filters: [string, unknown][];
  payload?: any;
};

/** In-memory Supabase boundary: unknown table access fails closed. */
function createDatabase() {
  const db = {
    logs: [] as any[],
    instances: [{ id: 'instance-1', site_id: 'site-1', status: 'running' },
      { id: 'instance-1', site_id: 'site-other', status: 'running' },
      { id: 'instance-other', site_id: 'site-1', status: 'running' }],
    queries: [] as Query[],
    updateError: null as string | null,
    insertError: null as string | null,
    lookupError: null as string | null,
    throwStatusUpdate: false,
    beforeUserStatusWrite: undefined as (() => void) | undefined,
  };
  const matches = (row: any, filters: Query['filters']) => filters.every(([column, value]) => {
    const actual = column.split(/->>?/).reduce((current, key) => current?.[key], row);
    return actual === value;
  });
  const from = jest.fn((table: string) => {
    if (table !== 'instance_logs' && table !== 'remote_instances') {
      throw new Error(`Unexpected table: ${table}`);
    }
    const query: Query = { table, operation: 'select', filters: [] };
    db.queries.push(query);
    const execute = async () => {
      if (table === 'remote_instances' && query.operation === 'update') {
        if (db.throwStatusUpdate) throw new Error('status transport unavailable');
        if (db.updateError) return { error: { message: db.updateError } };
      }
      if (table === 'instance_logs' && query.operation === 'insert') {
        if (db.insertError) return { error: { message: db.insertError } };
        const row = { id: `notice-${db.logs.length + 1}`, ...query.payload };
        db.logs.push(row);
        return { data: row, error: null };
      }
      if (table === 'instance_logs' && query.operation === 'select' &&
          query.filters.some(([key]) => key === 'details->>event_id') && db.lookupError) {
        return { error: { message: db.lookupError } };
      }
      if (table === 'instance_logs' && query.operation === 'update') db.beforeUserStatusWrite?.();
      const rows = (table === 'instance_logs' ? db.logs : db.instances)
        .filter(row => matches(row, query.filters));
      if (query.operation === 'update') rows.forEach(row => Object.assign(row, query.payload));
      return { data: rows[0] ? structuredClone(rows[0]) : null, error: null };
    };
    const chain: any = {
      eq: (column: string, value: unknown) => { query.filters.push([column, value]); return chain; },
      select: () => chain,
      limit: () => chain,
      insert: (payload: any) => { query.operation = 'insert'; query.payload = payload; return chain; },
      update: (payload: any) => { query.operation = 'update'; query.payload = payload; return chain; },
      maybeSingle: () => execute(),
      single: () => execute(),
      then: (resolve: any, reject: any) => execute().then(resolve, reject),
    };
    return chain;
  });
  return { db, supabaseAdmin: { from } };
}

function loadService(realUserStatus = false) {
  const database = createDatabase();
  const getCreditExhaustionNotice = jest.fn().mockResolvedValue(billingNotice);
  const userStatus = realUserStatus
    ? loadRuntimeModule<typeof import('@/app/api/robots/instance/assistant/user-message-log')>(
        'src/app/api/robots/instance/assistant/user-message-log.ts', {
          '@/lib/database/supabase-client': { supabaseAdmin: database.supabaseAdmin },
        },
      ).setUserMessageStatus
    : jest.fn().mockResolvedValue(true);
  const setUserMessageStatus = jest.fn(userStatus);
  const service = loadRuntimeModule<typeof import('@/lib/services/robot-instance/credit-exhaustion')>(
    'src/lib/services/robot-instance/credit-exhaustion.ts', {
      '@/lib/database/supabase-client': { supabaseAdmin: database.supabaseAdmin },
      '@/lib/services/billing/CreditService': { CreditService: { getCreditExhaustionNotice } },
      '@/app/api/robots/instance/assistant/user-message-log': { setUserMessageStatus },
      './assistant-recovery-schema': { RecoveryError },
    },
  );
  return { ...database, ...service, getCreditExhaustionNotice, setUserMessageStatus };
}

function addUserActions(db: ReturnType<typeof createDatabase>['db'], status = 'running', generation = 2) {
  db.logs.push({
    id: 'action-1', log_type: 'user_action', instance_id: 'instance-1', site_id: 'site-1',
    details: { status, assistant_recovery: { respawnCount: generation, revision: 'revision-1' } },
  }, {
    id: 'action-other', log_type: 'user_action', instance_id: 'instance-1', site_id: 'site-1',
    details: { status: 'running', assistant_recovery: { respawnCount: 5, revision: 'other-revision' } },
  });
}

describe('persistCreditExhaustionNotice', () => {
  it('persists an assistant-visible payload and pauses only the instance/site pair', async () => {
    const h = loadService();
    await expect(h.persistCreditExhaustionNotice(params)).resolves.toEqual(visibleNotice);
    expect(h.getCreditExhaustionNotice).toHaveBeenCalledWith('site-1');
    expect(h.db.logs).toEqual([expect.objectContaining({
      log_type: 'agent_action', level: 'info', message: visibleNotice.message,
      instance_id: 'instance-1', site_id: 'site-1', user_id: 'user-1',
      details: {
        event: 'credits_exhausted', code: 'INSUFFICIENT_CREDITS', streaming: false,
        response_type: 'assistant_response', next_credit_reset_at: billingNotice.nextResetAt,
        credits_available: 0, event_id: params.eventId,
        plan_id: 'plan-1', step_id: 'step-1', requirement_id: 'requirement-1',
      },
    })]);
    expect(h.db.instances.map(row => row.status)).toEqual(['paused', 'running', 'running']);
    expect(h.setUserMessageStatus).not.toHaveBeenCalled();
    expect(h.db.queries.find(q => q.table === 'remote_instances')?.filters)
      .toEqual([['id', 'instance-1'], ['site_id', 'site-1']]);
  });

  it('replays the existing event notice without another insert, scoped to instance/site/event', async () => {
    const h = loadService();
    // Identical event IDs in another instance/site or event must not suppress this notice.
    h.db.logs.push(
      { id: 'foreign-site', ...params, instance_id: 'instance-1', site_id: 'site-other',
        log_type: 'agent_action', details: { event: 'credits_exhausted', event_id: params.eventId } },
      { id: 'foreign-instance', instance_id: 'instance-other', site_id: 'site-1',
        log_type: 'agent_action', details: { event: 'credits_exhausted', event_id: params.eventId } },
      { id: 'foreign-event', instance_id: 'instance-1', site_id: 'site-1',
        log_type: 'agent_action', details: { event: 'different', event_id: params.eventId } },
    );
    await h.persistCreditExhaustionNotice(params);
    h.getCreditExhaustionNotice.mockResolvedValue({ ...billingNotice, message: 'Changed billing notice' });
    await expect(h.persistCreditExhaustionNotice(params)).resolves.toEqual(visibleNotice);
    expect(h.db.logs).toHaveLength(4);
    expect(h.db.queries.filter(q => q.operation === 'insert')).toHaveLength(1);
    const lookup = h.db.queries.find(q => q.table === 'instance_logs' && q.operation === 'select');
    expect(lookup?.filters).toEqual([
      ['instance_id', 'instance-1'], ['site_id', 'site-1'], ['log_type', 'agent_action'],
      ['details->>event_id', params.eventId], ['details->>event', 'credits_exhausted'],
    ]);
  });

  it('uses the deterministic Spanish fallback when the billing notice/date read throws', async () => {
    const h = loadService();
    h.getCreditExhaustionNotice.mockRejectedValue(new Error('billing date unavailable'));
    const result = await h.persistCreditExhaustionNotice({ instanceId: 'instance-1', siteId: 'site-1', eventId: 'unknown-date' });
    expect(result).toEqual({ message: fallbackMessage, nextResetAt: null, available: null });
    expect(h.db.logs[0]).toMatchObject({ user_id: null, message: fallbackMessage,
      details: { next_credit_reset_at: null, credits_available: null, plan_id: null, step_id: null, requirement_id: null } });
    expect(h.db.logs[0].details).not.toHaveProperty('user_message_log_id');
  });

  it('uses the real user-action CAS, preserving generation and every other action', async () => {
    const h = loadService(true);
    addUserActions(h.db);
    const originalOther = structuredClone(h.db.logs[1]);
    const guarded = { ...params, userMessageLogId: 'action-1', expectedGeneration: 2 };
    await h.persistCreditExhaustionNotice(guarded);
    await h.persistCreditExhaustionNotice(guarded);
    expect(h.setUserMessageStatus).toHaveBeenCalledWith('action-1', 'paused', 2);
    expect(h.db.logs[0].details).toEqual({ status: 'paused',
      assistant_recovery: { respawnCount: 2, revision: 'revision-1' } });
    expect(h.db.logs[1]).toEqual(originalOther);
    expect(h.db.logs.filter(row => row.log_type === 'agent_action')).toHaveLength(1);
    expect(h.db.logs[2].details.user_message_log_id).toBe('action-1');
    const cas = h.db.queries.find(q => q.table === 'instance_logs' && q.operation === 'update');
    expect(cas?.filters).toEqual([['id', 'action-1'], ['log_type', 'user_action'],
      ['details->>status', 'running'], ['details->assistant_recovery->>revision', 'revision-1']]);
  });

  it.each(['cancelled', 'stopped', 'completed', 'failed'])('rejects %s original actions with no stale instance or log writes', async status => {
    const h = loadService(true);
    addUserActions(h.db, status);
    const logs = structuredClone(h.db.logs);
    await expect(h.persistCreditExhaustionNotice({ ...params, userMessageLogId: 'action-1', expectedGeneration: 2 }))
      .rejects.toMatchObject({ name: 'RecoveryError', code: 'inactive' });
    expect(h.db.logs).toEqual(logs);
    expect(h.db.instances.every(row => row.status === 'running')).toBe(true);
    expect(h.db.queries.every(q => q.operation === 'select')).toBe(true);
  });

  it.each(['new_generation', 'active_lease', 'revision_race'])('rejects %s through the real CAS with no instance or notice writes', async scenario => {
    const h = loadService(true);
    addUserActions(h.db);
    if (scenario === 'new_generation') h.db.logs[0].details.assistant_recovery.respawnCount = 3;
    if (scenario === 'active_lease') h.db.logs[0].details.assistant_recovery.lease_token = 'local-lease';
    if (scenario === 'revision_race') h.db.beforeUserStatusWrite = () => {
      h.db.logs[0].details.status = 'cancelled';
      h.db.logs[0].details.assistant_recovery.revision = 'new-revision';
    };
    await expect(h.persistCreditExhaustionNotice({ ...params, userMessageLogId: 'action-1', expectedGeneration: 2 }))
      .rejects.toMatchObject({ name: 'RecoveryError', code: 'inactive' });
    expect(h.db.instances.every(row => row.status === 'running')).toBe(true);
    expect(h.db.logs.filter(row => row.log_type === 'agent_action')).toHaveLength(0);
    expect(h.db.logs[0].details.status).toBe(scenario === 'revision_race' ? 'cancelled' : 'running');
    expect(h.db.logs[1].details.status).toBe('running');
    expect(h.db.queries.some(q => q.table === 'remote_instances' || q.operation === 'insert')).toBe(false);
  });

  it('does not proceed after a false unversioned pause or a missing action for a supplied generation', async () => {
    const h = loadService();
    h.setUserMessageStatus.mockResolvedValue(false);
    await expect(h.persistCreditExhaustionNotice({ ...params, userMessageLogId: 'action-1' }))
      .rejects.toMatchObject({ name: 'RecoveryError', code: 'inactive' });
    expect(h.setUserMessageStatus).toHaveBeenCalledWith('action-1', 'paused', undefined);
    await expect(h.persistCreditExhaustionNotice({ ...params, expectedGeneration: 2 }))
      .rejects.toMatchObject({ name: 'RecoveryError', code: 'inactive' });
    expect(h.db.queries).toHaveLength(0);
  });

  it('rechecks ownership after billing read and before any user CAS, instance or log writes', async () => {
    const h = loadService();
    const stale = new Error('ownership lost during billing read');
    const beforeWrite = jest.fn().mockRejectedValue(stale);
    await expect(h.persistCreditExhaustionNotice({ ...params, userMessageLogId: 'action-1', expectedGeneration: 2, beforeWrite }))
      .rejects.toBe(stale);
    expect(h.getCreditExhaustionNotice.mock.invocationCallOrder[0]).toBeLessThan(beforeWrite.mock.invocationCallOrder[0]);
    expect(h.setUserMessageStatus).not.toHaveBeenCalled();
    expect(h.db.queries).toHaveLength(0);
  });

  it.each([false, true])('persists the visible notice even if instance status fails (transport rejection: %s)', async transport => {
    const h = loadService();
    h.db.updateError = 'status denied';
    h.db.throwStatusUpdate = transport;
    await expect(h.persistCreditExhaustionNotice(params)).rejects.toThrow(transport ? 'status transport unavailable' : 'status denied');
    expect(h.db.logs).toHaveLength(1);
    h.db.updateError = null;
    h.db.throwStatusUpdate = false;
    await h.persistCreditExhaustionNotice(params);
    expect(h.db.logs).toHaveLength(1);
    expect(h.db.instances[0].status).toBe('paused');
  });

  it('pauses status even if notice insert fails, surfaces the failure, and retries the missing log', async () => {
    const h = loadService();
    h.db.insertError = 'log denied';
    await expect(h.persistCreditExhaustionNotice(params)).rejects.toThrow('log denied');
    expect(h.db.instances[0].status).toBe('paused');
    expect(h.db.logs).toHaveLength(0);
    h.db.insertError = null;
    await h.persistCreditExhaustionNotice(params);
    expect(h.db.logs).toHaveLength(1);
  });

  it('does not insert when event lookup fails, but still attempts instance pause', async () => {
    const h = loadService();
    h.db.lookupError = 'lookup unavailable';
    await expect(h.persistCreditExhaustionNotice(params)).rejects.toThrow('lookup unavailable');
    expect(h.db.instances[0].status).toBe('paused');
    expect(h.db.queries.filter(q => q.operation === 'insert')).toHaveLength(0);
  });

  it('retains both independent failures when status and log writes fail', async () => {
    const h = loadService();
    h.db.updateError = 'status denied';
    h.db.insertError = 'log denied';
    const failure: any = await h.persistCreditExhaustionNotice(params).catch(error => error);
    expect(failure.name).toBe('AggregateError');
    expect(failure.errors.map((error: Error) => error.message)).toEqual([
      'Failed to pause robot for credits: status denied',
      'Failed to persist credit exhaustion notice: log denied',
    ]);
  });
});

function loadSteps() {
  const requireCredits = jest.fn().mockResolvedValue(undefined);
  const assertCronExecutionOwnership = jest.fn().mockResolvedValue(undefined);
  const persistCreditExhaustionNotice = jest.fn(async (input: { beforeWrite?: () => Promise<void> }) => {
    await input.beforeWrite?.();
    return visibleNotice;
  });
  const steps = loadRuntimeModule<typeof import('../credit-exhaustion-step')>(
    'src/app/api/cron/shared/credit-exhaustion-step.ts', {
      '@/lib/services/billing/CreditService': { CreditService: { requireCredits } },
      '@/lib/services/billing/credit-exhaustion-message': billingErrors,
      '@/lib/services/robot-instance/credit-exhaustion': { persistCreditExhaustionNotice },
      './cron-execution-ownership': { assertCronExecutionOwnership },
    },
  );
  return { ...steps, requireCredits, persistCreditExhaustionNotice, assertCronExecutionOwnership };
}

describe('credit exhaustion durable steps', () => {
  it('checks a small credit floor without spending credits', async () => {
    const h = loadSteps();
    await expect(h.checkCycleCreditsStep('site-1')).resolves.toBe(true);
    expect(h.requireCredits).toHaveBeenCalledWith('site-1', 0.001);
    expect(h.persistCreditExhaustionNotice).not.toHaveBeenCalled();
  });

  it.each([false, true])('returns false only for an explicit shortage (wrapped: %s)', async wrapped => {
    const h = loadSteps();
    const shortage = new billingErrors.InsufficientCreditsError('floor rejected');
    h.requireCredits.mockRejectedValue(wrapped ? new Error('step failed', { cause: shortage }) : shortage);
    await expect(h.checkCycleCreditsStep('site-1')).resolves.toBe(false);
  });

  it('rethrows a billing outage, even when its text mentions insufficient credits', async () => {
    const h = loadSteps();
    const outage = new Error('Insufficient credits check unavailable: database outage');
    h.requireCredits.mockRejectedValue(outage);
    await expect(h.checkCycleCreditsStep('site-1')).rejects.toBe(outage);
    expect(h.persistCreditExhaustionNotice).not.toHaveBeenCalled();
  });

  const ownership: CronExecutionOwnership = {
    requirementId: 'requirement-1', runId: 'run-1', executionGeneration: 7,
  };
  it('asserts original cron ownership before emitting a stable cycle event, without resetting generation', async () => {
    const h = loadSteps();
    const originalOwnership = { ...ownership };
    await expect(h.emitCreditExhaustionStep({ ...params, cycleId: 'cycle-1', ownership })).resolves.toEqual(visibleNotice);
    expect(h.assertCronExecutionOwnership).toHaveBeenCalledWith({ ...ownership, allowTerminal: true });
    expect(h.assertCronExecutionOwnership).toHaveBeenCalledTimes(2);
    expect(h.persistCreditExhaustionNotice).toHaveBeenCalledWith({ ...params, beforeWrite: expect.any(Function) });
    expect(h.assertCronExecutionOwnership.mock.invocationCallOrder[0])
      .toBeLessThan(h.persistCreditExhaustionNotice.mock.invocationCallOrder[0]);
    expect(ownership).toEqual(originalOwnership);
  });

  it('rejects stale cron ownership without persisting any notice or instance change', async () => {
    const h = loadSteps();
    const stale = Object.assign(new Error('new generation owns this requirement'), { name: 'CronExecutionOwnershipError' });
    h.assertCronExecutionOwnership.mockRejectedValue(stale);
    await expect(h.emitCreditExhaustionStep({ ...params, cycleId: 'cycle-stale', ownership })).rejects.toBe(stale);
    expect(h.persistCreditExhaustionNotice).not.toHaveBeenCalled();
  });

  it('rejects ownership lost during the billing read, before the real service writes anything', async () => {
    const h = loadService();
    const stale = Object.assign(new Error('ownership expired during billing read'), { name: 'CronExecutionOwnershipError' });
    const assertCronExecutionOwnership = jest.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(stale);
    const steps = loadRuntimeModule<typeof import('../credit-exhaustion-step')>(
      'src/app/api/cron/shared/credit-exhaustion-step.ts', {
        '@/lib/services/billing/CreditService': { CreditService: {} },
        '@/lib/services/billing/credit-exhaustion-message': billingErrors,
        '@/lib/services/robot-instance/credit-exhaustion': { persistCreditExhaustionNotice: h.persistCreditExhaustionNotice },
        './cron-execution-ownership': { assertCronExecutionOwnership },
      },
    );
    await expect(steps.emitCreditExhaustionStep({ ...params, cycleId: 'cycle-1', ownership })).rejects.toBe(stale);
    expect(h.getCreditExhaustionNotice).toHaveBeenCalledTimes(1);
    expect(assertCronExecutionOwnership).toHaveBeenCalledTimes(2);
    expect(h.db.queries).toHaveLength(0);
  });
});