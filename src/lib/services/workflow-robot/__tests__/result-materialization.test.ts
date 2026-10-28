const from = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from } }));
import { materializeRunFromGraph } from '../materialize';

describe('result contract version at materialization', () => {
  let inserts: Array<{ table: string; payload: any }>;
  let existing: any;
  beforeEach(() => {
    jest.clearAllMocks(); inserts = []; existing = null;
    from.mockImplementation((table: string) => {
      let payload: any;
      const query: any = {};
      for (const method of ['select', 'eq', 'in', 'contains', 'order', 'limit']) query[method] = () => query;
      query.insert = (value: any) => { payload = value; inserts.push({ table, payload }); return query; };
      query.update = () => query;
      query.delete = () => query;
      const result = () => {
        if (payload) return { data: { id: table === 'workflow_runs' ? 'run' : payload.metadata?.workflow_run ? 'run-plan' : 'template' }, error: null };
        if (table === 'remote_instances') return { data: { id: 'instance', site_id: 'site', user_id: 'user', name: 'Task' }, error: null };
        if (table === 'instance_nodes') return { data: [
          { id: 'trigger', type: 'wf-trigger', instance_id: 'instance', site_id: 'site', settings: { trigger: { kind: 'channel_message' } } },
          { id: 'step', type: 'wf-step', parent_node_id: 'trigger', instance_id: 'instance', site_id: 'site', prompt: { text: 'Analyze input' }, settings: {} },
        ], error: null };
        if (table === 'workflow_triggers') return { data: { template_plan_id: 'template', node_id: 'trigger' }, error: null };
        if (table === 'workflow_runs') return { data: existing, error: null };
        return { data: null, error: null };
      };
      query.maybeSingle = query.single = async () => result();
      query.then = (resolve: any, reject: any) => Promise.resolve(result()).then(resolve, reject);
      return query;
    });
  });

  it('pins v2 on a new ordinary run without writing the version to its template', async () => {
    // Do not synchronize triggers here: trigger materialization uses the existing
    // graph/template path but new-run metadata remains owned by the host.
    const { materializeRunFromGraph: materialize } = await import('../materialize');
    const original = from.getMockImplementation()!;
    from.mockImplementation((table: string) => {
      if (table !== 'workflow_triggers') return original(table);
      const q: any = { select: () => q, eq: () => q,
        then: (resolve: any) => Promise.resolve({ data: [], error: null }).then(resolve) };
      q.insert = (payload: any) => { inserts.push({ table, payload }); return q; };
      q.single = async () => ({ data: { id: 'trigger' }, error: null });
      return q;
    });
    await materialize({ instance_id: 'instance', trigger_payload: {} });
    const plans = inserts.filter(row => row.table === 'instance_plans');
    expect(plans.find(row => row.payload.metadata.workflow_template)!.payload.metadata).not.toHaveProperty('result_contract_version');
    expect(plans.find(row => row.payload.metadata.workflow_run)!.payload.metadata.result_contract_version).toBe(2);
  });

  it('does not opt bounded channel runs into the ordinary contract', async () => {
    await materializeRunFromGraph({ instance_id: 'instance', trigger_id: 'trigger', pre_response_only: true, trigger_payload: {} });
    const run = inserts.find(row => row.table === 'instance_plans' && row.payload.metadata.workflow_run)!;
    expect(run.payload.metadata.pre_response_only).toBe(true);
    expect(run.payload.metadata).not.toHaveProperty('result_contract_version');
  });

  it('does not rewrite a run when the original event is delivered again', async () => {
    existing = { id: 'run', run_plan_id: 'old-plan', template_plan_id: 'template', dry_run: false, status: 'pending' };
    const result = await materializeRunFromGraph({ instance_id: 'instance', idempotency_key: 'event', trigger_payload: {} });
    expect(result.run_plan_id).toBe('old-plan');
    expect(inserts).toEqual([]);
  });
});