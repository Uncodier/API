/**
 * Assistant Protocol Wrapper for Report Tool
 *
 * The agent provides high-level parameters (table, filters, columns, pagination).
 * This tool builds and executes the query internally — the agent never writes SQL.
 *
 * The schema is automatically included in every response so the agent always
 * knows which columns are available before filtering or selecting.
 */

import { runReportQuery, type FilterCondition } from './query/route';
import { getSchemaCore } from './schema/route';

export interface ReportToolParams {
  action: 'list' | 'count';
  table: string;
  columns?: string[];
  filters?: FilterCondition[];
  order_by?: string;
  order_dir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

// Compact schema summary injected into every response.
// Tells the agent exactly which columns each table has before it queries.
function buildSchemaSummary(): Record<string, string[]> {
  const schema = getSchemaCore('_', '_');
  if (!schema.success || !schema.tables) return {};
  return Object.fromEntries(
    schema.tables.map(t => [
      t.table_name,
      t.columns.map(c => `${c.column_name}:${c.data_type}${c.notes ? ` (${c.notes})` : ''}`),
    ])
  );
}

const SCHEMA_SUMMARY = buildSchemaSummary();

// Tables that do NOT have a direct site_id column
const NO_DIRECT_SITE_ID = new Set(['messages', 'agent_memories', 'audience_leads']);

export function reportTool(site_id: string, user_id: string) {
  const execute = async (args: ReportToolParams) => {
    const { action, table, columns, filters, order_by, order_dir, limit, offset } = args;

    if (action !== 'list' && action !== 'count') {
      return { success: false, error: `Invalid action "${action}". Use "list" or "count".` };
    }

    // Warn the agent if it tried to filter by site_id on a table that doesn't have it
    if (NO_DIRECT_SITE_ID.has(table)) {
      const badFilter = (filters ?? []).find(f => f.column === 'site_id');
      if (badFilter) {
        return {
          success: false,
          error: `Table "${table}" does not have a direct site_id column — site scoping is handled automatically via a join. Remove the site_id filter and retry.`,
          schema: SCHEMA_SUMMARY[table] ?? [],
        };
      }
    }

    try {
      const result = await runReportQuery({
        table: table as any,
        site_id,
        user_id,
        columns,
        filters,
        order_by,
        order_dir,
        limit: limit ?? 50,
        offset: offset ?? 0,
        count_only: action === 'count',
      });

      // Always attach the table's column list so the agent can self-correct
      return {
        ...result,
        table_schema: SCHEMA_SUMMARY[table] ?? [],
      };
    } catch (err: any) {
      return {
        success: false,
        error: err?.message ?? 'Unknown error',
        table_schema: SCHEMA_SUMMARY[table] ?? [],
      };
    }
  };

  // Build the schema description block for the tool description
  const schemaBlock = Object.entries(SCHEMA_SUMMARY)
    .map(([tbl, cols]) => `• ${tbl}: ${cols.join(', ')}`)
    .join('\n');

  return {
    name: 'report',
    description: `Query data from the database. Use action="list" to get up to 50 records. Use action="count" to get the total matching a filter.

IMPORTANT — column reference (the schema is also returned in every response as table_schema):
${schemaBlock}

Tables WITHOUT a direct site_id (scoped automatically via join — do NOT filter by site_id on these):
• messages — scoped via conversations.site_id
• agent_memories — scoped via agents.site_id
• audience_leads — scoped via audiences.site_id

Rules:
- Never add a site_id filter — it is applied automatically.
- Use "count" first to know the total before paginating.
- Increment offset by limit to get the next page. Stop when has_more=false.
- If you get a column error, check table_schema in the response and retry with correct column names.`,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'count'],
          description: '"list" returns rows. "count" returns only the total.',
        },
        table: {
          type: 'string',
          enum: [
            'leads', 'conversations', 'messages', 'tasks', 'campaigns',
            'segments', 'content', 'requirements', 'agents', 'commands',
            'visitors', 'agent_memories', 'sites', 'audiences', 'audience_leads',
          ],
          description: 'Table to query.',
        },
        columns: {
          type: 'array',
          items: { type: 'string' },
          description: 'Columns to return. Omit to return all. Use only column names from table_schema.',
        },
        filters: {
          type: 'array',
          description: 'Filter conditions. Do NOT include site_id — it is automatic.',
          items: {
            type: 'object',
            properties: {
              column: { type: 'string', description: 'Column name (must exist in the table).' },
              operator: {
                type: 'string',
                enum: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in'],
              },
              value: { description: 'Value to compare. Use array for "in".' },
            },
            required: ['column', 'operator', 'value'],
          },
        },
        order_by: { type: 'string', description: 'Column to sort by. Default: created_at.' },
        order_dir: { type: 'string', enum: ['asc', 'desc'], description: 'Default: desc.' },
        limit: { type: 'number', description: 'Max rows (1–50). Default: 50.' },
        offset: { type: 'number', description: 'Pagination offset. Start at 0.' },
      },
      required: ['action', 'table'],
    },
    handler: execute,
    execute,
  };
}
