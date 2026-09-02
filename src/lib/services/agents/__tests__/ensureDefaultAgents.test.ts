import { DEFAULT_AGENT_TEMPLATES } from '../default-agent-templates';
import { ensureDefaultAgents, findActiveAgentForRole } from '../ensureDefaultAgents';

const SITE_ID = '353b235b-1242-4e5e-9bfa-f0cf23363483';
const USER_ID = '541396e1-a904-4a81-8cbf-0ca4e3b8b2b4';

type AgentRow = {
  id: string;
  role: string;
  status: string;
  user_id: string;
  site_id: string;
  created_at?: string;
  prompt?: string;
  backstory?: string;
};

const mockFrom = jest.fn();

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockFrom(...args),
  },
}));

function createBuilder(store: { rows: AgentRow[] }) {
  const ctx: {
    filters: Array<[string, unknown]>;
    insertRow: Record<string, unknown> | null;
    updatePatch: Record<string, unknown> | null;
    orderCol: string | null;
    orderAsc: boolean;
    limitN: number | null;
  } = {
    filters: [],
    insertRow: null,
    updatePatch: null,
    orderCol: null,
    orderAsc: true,
    limitN: null,
  };

  const execute = () => {
    if (ctx.insertRow) {
      const created: AgentRow = {
        id: `agent-${store.rows.length + 1}`,
        role: String(ctx.insertRow.role),
        status: String(ctx.insertRow.status),
        user_id: String(ctx.insertRow.user_id),
        site_id: String(ctx.insertRow.site_id),
        created_at: String(ctx.insertRow.created_at || ''),
        prompt: ctx.insertRow.prompt as string | undefined,
        backstory: ctx.insertRow.backstory as string | undefined,
      };
      store.rows.push(created);
      return { data: created, error: null };
    }

    const matches = (row: AgentRow) =>
      ctx.filters.every(([key, value]) => (row as Record<string, unknown>)[key] === value);

    if (ctx.updatePatch) {
      store.rows = store.rows.map((row) => (matches(row) ? { ...row, ...ctx.updatePatch } : row));
      return { data: null, error: null };
    }

    let data = store.rows.filter(matches);
    if (ctx.orderCol) {
      data = [...data].sort((a, b) => {
        const left = String((a as Record<string, unknown>)[ctx.orderCol!] ?? '');
        const right = String((b as Record<string, unknown>)[ctx.orderCol!] ?? '');
        return ctx.orderAsc ? left.localeCompare(right) : right.localeCompare(left);
      });
    }
    if (ctx.limitN != null) {
      data = data.slice(0, ctx.limitN);
    }
    return { data, error: null };
  };

  const builder: any = {
    select: () => builder,
    insert: (row: Record<string, unknown>) => {
      ctx.insertRow = row;
      return builder;
    },
    update: (patch: Record<string, unknown>) => {
      ctx.updatePatch = patch;
      return builder;
    },
    eq: (column: string, value: unknown) => {
      ctx.filters.push([column, value]);
      return builder;
    },
    order: (column: string, options?: { ascending?: boolean }) => {
      ctx.orderCol = column;
      ctx.orderAsc = options?.ascending !== false;
      return builder;
    },
    limit: (count: number) => {
      ctx.limitN = count;
      return builder;
    },
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(execute()).then(resolve, reject),
  };

  return builder;
}

describe('ensureDefaultAgents', () => {
  const store = { rows: [] as AgentRow[] };

  beforeEach(() => {
    store.rows = [];
    mockFrom.mockImplementation(() => createBuilder(store));
  });

  it('creates the missing roster when only Customer Support exists', async () => {
    store.rows = [
      {
        id: 'cs-1',
        role: 'Customer Support',
        status: 'active',
        user_id: USER_ID,
        site_id: SITE_ID,
      },
    ];

    const result = await ensureDefaultAgents(SITE_ID, USER_ID);

    expect(result.existing).toEqual(['Customer Support']);
    expect(result.created).toHaveLength(DEFAULT_AGENT_TEMPLATES.length - 1);
    expect(result.created).toContain('Sales/CRM Specialist');
    expect(result.reactivated).toEqual([]);
    expect(store.rows).toHaveLength(DEFAULT_AGENT_TEMPLATES.length);
  });

  it('does not insert when the full roster is already active', async () => {
    store.rows = DEFAULT_AGENT_TEMPLATES.map((template, index) => ({
      id: `agent-${index}`,
      role: template.role,
      status: 'active',
      user_id: USER_ID,
      site_id: SITE_ID,
      prompt: 'keep-me',
      backstory: 'keep-me-too',
    }));

    const result = await ensureDefaultAgents(SITE_ID, USER_ID);

    expect(result.created).toEqual([]);
    expect(result.reactivated).toEqual([]);
    expect(result.existing).toHaveLength(DEFAULT_AGENT_TEMPLATES.length);
    expect(store.rows.every((row) => row.prompt === 'keep-me')).toBe(true);
  });

  it('reactivates an inactive Sales agent instead of duplicating it', async () => {
    store.rows = DEFAULT_AGENT_TEMPLATES.map((template, index) => ({
      id: `agent-${index}`,
      role: template.role,
      status: template.role === 'Sales/CRM Specialist' ? 'inactive' : 'active',
      user_id: USER_ID,
      site_id: SITE_ID,
      prompt: 'original-prompt',
    }));

    const result = await ensureDefaultAgents(SITE_ID, USER_ID);

    expect(result.created).toEqual([]);
    expect(result.reactivated).toEqual(['Sales/CRM Specialist']);
    const sales = store.rows.find((row) => row.role === 'Sales/CRM Specialist');
    expect(sales?.status).toBe('active');
    expect(sales?.prompt).toBe('original-prompt');
    expect(store.rows.filter((row) => row.role === 'Sales/CRM Specialist')).toHaveLength(1);
  });

  it('finds the active agent for a role after seeding', async () => {
    store.rows = [
      {
        id: 'sales-1',
        role: 'Sales/CRM Specialist',
        status: 'active',
        user_id: USER_ID,
        site_id: SITE_ID,
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ];

    const found = await findActiveAgentForRole(SITE_ID, 'Sales/CRM Specialist');
    expect(found).toEqual({
      agentId: 'sales-1',
      userId: USER_ID,
      role: 'Sales/CRM Specialist',
    });
  });
});
