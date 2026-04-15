import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';

// Tables the agent is allowed to query
const ALLOWED_TABLES = [
  'agents', 'agent_memories', 'audiences', 'audience_leads', 'campaigns',
  'commands', 'content', 'conversations', 'leads', 'messages',
  'requirements', 'segments', 'sites', 'tasks', 'visitors',
] as const;

type AllowedTable = typeof ALLOWED_TABLES[number];

// Tables that don't have a direct site_id column and how to scope them
const SITE_SCOPE: Record<string, { via: 'join'; join: string; filter: string } | { via: 'direct' }> = {
  messages:       { via: 'join', join: 'conversations!inner(site_id)', filter: 'conversations.site_id' },
  agent_memories: { via: 'join', join: 'agents!inner(site_id)',        filter: 'agents.site_id' },
  audience_leads: { via: 'join', join: 'audiences!inner(site_id)',     filter: 'audiences.site_id' },
};

export interface FilterCondition {
  column: string;
  operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'ilike' | 'is' | 'in';
  value: unknown;
}

export interface ReportQueryParams {
  table: AllowedTable;
  site_id: string;
  user_id: string;
  columns?: string[];       // which columns to select; omit for all
  filters?: FilterCondition[];
  order_by?: string;
  order_dir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
  count_only?: boolean;     // return just the total count
}

export interface ReportQueryResult {
  success: boolean;
  rows?: Record<string, unknown>[];
  total?: number;
  has_more?: boolean;
  error?: string;
}

function isAllowedTable(t: string): t is AllowedTable {
  return (ALLOWED_TABLES as readonly string[]).includes(t);
}

function isSimpleColumn(col: string): boolean {
  // Only allow plain column names — no expressions, no injections
  return /^[a-z_][a-z0-9_]*$/.test(col);
}

export async function runReportQuery(params: ReportQueryParams): Promise<ReportQueryResult> {
  const {
    table,
    site_id,
    columns,
    filters = [],
    order_by = 'created_at',
    order_dir = 'desc',
    limit = 50,
    offset = 0,
    count_only = false,
  } = params;

  if (!isAllowedTable(table)) {
    return { success: false, error: `Table "${table}" is not allowed. Allowed: ${ALLOWED_TABLES.join(', ')}` };
  }

  if (!site_id) {
    return { success: false, error: 'site_id is required' };
  }

  // Validate column names
  const selectColumns = columns && columns.length > 0 ? columns : ['*'];
  for (const col of selectColumns) {
    if (col !== '*' && !isSimpleColumn(col)) {
      return { success: false, error: `Invalid column name: "${col}"` };
    }
  }

  if (!isSimpleColumn(order_by)) {
    return { success: false, error: `Invalid order_by column: "${order_by}"` };
  }

  const safeLimit = Math.min(Math.max(1, limit), 100);

  try {
    const scope = SITE_SCOPE[table];
    const useJoin = scope && scope.via === 'join';

    // Build the select string — for join-scoped tables, include the join relation
    const baseSelect = selectColumns.join(', ');
    const selectStr = useJoin
      ? `${baseSelect}, ${(scope as { via: 'join'; join: string }).join}`
      : baseSelect;

    let query = supabaseAdmin
      .from(table)
      .select(selectStr, { count: 'exact' });

    // Apply site scoping
    if (useJoin) {
      query = query.eq((scope as { via: 'join'; filter: string }).filter, site_id);
    } else {
      query = query.eq('site_id', site_id);
    }

    // Apply caller-provided filters
    for (const f of filters) {
      if (!isSimpleColumn(f.column)) {
        return { success: false, error: `Invalid filter column: "${f.column}"` };
      }
      switch (f.operator) {
        case 'eq':    query = query.eq(f.column, f.value); break;
        case 'neq':   query = query.neq(f.column, f.value); break;
        case 'gt':    query = query.gt(f.column, f.value); break;
        case 'gte':   query = query.gte(f.column, f.value); break;
        case 'lt':    query = query.lt(f.column, f.value); break;
        case 'lte':   query = query.lte(f.column, f.value); break;
        case 'like':  query = query.like(f.column, String(f.value)); break;
        case 'ilike': query = query.ilike(f.column, String(f.value)); break;
        case 'is':    query = query.is(f.column, f.value as null); break;
        case 'in':    query = query.in(f.column, f.value as unknown[]); break;
      }
    }

    if (count_only) {
      query = query.limit(0);
    } else {
      query = query
        .order(order_by, { ascending: order_dir === 'asc' })
        .range(offset, offset + safeLimit - 1);
    }

    const { data, error, count } = await query;

    if (error) {
      return { success: false, error: error.message };
    }

    const total = count ?? 0;

    if (count_only) {
      return { success: true, total };
    }

    // Strip the join relation key from rows (it was only needed for scoping)
    const joinKey = useJoin
      ? (scope as { via: 'join'; join: string }).join.split('!')[0]
      : null;

    const rows = (data ?? []).map((row: any) => {
      if (joinKey && joinKey in row) {
        const { [joinKey]: _dropped, ...rest } = row;
        return rest;
      }
      return row;
    }) as Record<string, unknown>[];

    return {
      success: true,
      rows,
      total,
      has_more: offset + safeLimit < total,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, error: message };
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const result = await runReportQuery(body);
    if (!result.success) {
      return NextResponse.json(result, { status: 400 });
    }
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
