import { randomUUID } from 'node:crypto';
import { Bindings, typed } from './supabase-select-bindings';
import { invalid, simpleName } from './supabase-select-lexer';
import { parseSelect, type Expr, type Predicate, type Select } from './supabase-select-parser';
import type { AnalyticsColumnType, AnalyticsDataset, AnalyticsResultType, AnalyticsSource, CompiledAnalyticsSelect } from './supabase-select-types';
export type { AnalyticsColumnType, AnalyticsDataset, AnalyticsResultType, AnalyticsSource, CompiledAnalyticsSelect } from './supabase-select-types';

type Field = { name: string; type: AnalyticsColumnType; sql: string };
type Output = { name: string; type: AnalyticsResultType; sql: string; group?: string; money?: true };
type Filter = { sql: string; fixesCurrency: boolean };
const columnTypes = new Set<AnalyticsColumnType>(['text', 'integer', 'numeric', 'date', 'timestamptz', 'boolean', 'uuid']);
const operators = new Map(['=', '<>', '<', '<=', '>', '>='].map(s => [s, `OPERATOR(pg_catalog.${s})`]));

// FROM binds to one trusted capability, never to the client's table name/search_path. The only
// identifier emitted from a caller reference must resolve to an own, simple name in its columns.
class Relation {
  constructor(readonly name: string, private readonly alias: string | undefined, readonly src: AnalyticsSource) {
    const money = src.money;
    if (money && (!simpleName(money.currency) || !Object.hasOwn(src.columns, money.currency) || src.columns[money.currency] !== 'text' ||
      !money.measures.length || !money.measures.every(c => simpleName(c) && Object.hasOwn(src.columns, c) && ['numeric', 'integer'].includes(src.columns[c])))) {
      invalid('This source does not have a valid monetary measure and currency mapping.');
    }
  }
  field(path: string[]): Field {
    if ((path.length === 3 && (path[0] !== 'analytics' || this.alias)) ||
        (path.length >= 2 && path[path.length - 2] !== (this.alias ?? this.name))) invalid();
    const name = path[path.length - 1];
    if (!Object.hasOwn(this.src.columns, name)) invalid('Use only columns listed for this analytics source.');
    const type = this.src.columns[name];
    if (!columnTypes.has(type)) invalid();
    return { name, type, sql: `r."${name}"` };
  }
  dimension(path: string[]) {
    const field = this.field(path);
    if (field.type === 'uuid') invalid('Identifiers are available only inside COUNT(DISTINCT column).');
    return { ...field, type: field.type, sql: typed(field.sql, field.type) };
  }
  output(expr: Expr, alias?: string): Output {
    if (expr.fn === 'count') return { name: alias ?? 'count', type: 'integer', sql: 'pg_catalog.count(*)' };
    if (expr.fn === 'count_distinct') {
      const f = this.field(expr.path);
      const value = f.type === 'uuid' ? `${f.sql}::pg_catalog.uuid` : typed(f.sql, f.type);
      return { name: alias ?? 'count', type: 'integer', sql: `pg_catalog.count(DISTINCT ${value})` };
    }
    const f = this.dimension(expr.path);
    if (expr.fn === null) return { name: alias ?? f.name, type: f.type, group: f.name, sql: f.sql };
    const name = alias ?? expr.fn;
    const measure = this.src.money?.measures.includes(f.name);
    switch (expr.fn) {
      case 'sum': case 'avg': {
        if (f.type !== 'numeric' && f.type !== 'integer') invalid('Use SUM or AVG only on a numeric measure.');
        return { name, type: 'numeric', sql: `pg_catalog.${expr.fn}(${typed(f.sql, 'numeric')})`, ...(measure && { money: true }) };
      }
      case 'min': case 'max': {
        if (f.type === 'boolean') invalid('Use MIN or MAX only on a number, date, timestamp or text column.');
        return { name, type: f.type, sql: `pg_catalog.${expr.fn}(${f.sql})`, ...(measure && { money: true }) };
      }
    }
  }
  predicate(node: Predicate, binds: Bindings): Filter {
    if (node.kind === 'and' || node.kind === 'or') {
      const left = this.predicate(node.left, binds), right = this.predicate(node.right, binds);
      // A positive equality under an OR does not constrain all qualifying rows. A top-level AND
      // conjunct can prove the currency even if another conjunct contains a disjunction.
      return { sql: `(${left.sql} ${node.kind === 'and' ? 'AND' : 'OR'} ${right.sql})`,
        fixesCurrency: node.kind === 'and' && (left.fixesCurrency || right.fixesCurrency) };
    }
    if (node.kind === 'comparison' || node.kind === 'null') {
      const f = this.dimension(node.path);
      if (node.kind === 'null') return { sql: `${f.sql} IS ${node.negated ? 'NOT ' : ''}NULL`, fixesCurrency: false };
      const op = operators.get(node.op);
      if (!op || (f.type === 'boolean' && node.op !== '=' && node.op !== '<>')) invalid();
      const { value, sql } = binds.comparison(node.rhs, f.type);
      return { sql: `(${f.sql} ${op} ${sql})`,
        fixesCurrency: f.name === this.src.money?.currency && node.op === '=' && value.length === 3 && /^[A-Z]{3}$/.test(value) };
    }
    return invalid();
  }
}

function resolveGroups(plan: Select, relation: Relation, projections: Output[], allowRows: boolean) {
  if (!projections.some(p => !p.group)) {
    if (!allowRows) invalid('This scope requires an aggregate SELECT. Row samples are only available for explicitly admitted workspace sources.');
    if (plan.groups.length) invalid('For a workspace row sample omit GROUP BY. For a grouped summary include an aggregate.');
    return '';
  }
  // As in PostgreSQL, GROUP BY prefers the input column to a conflicting output alias.
  const fields = plan.groups.map(path => {
    if (path.length === 1 && !Object.hasOwn(relation.src.columns, path[0])) {
      const output = projections.find(p => p.name === path[0]);
      if (output?.group) return relation.dimension([output.group]);
    }
    return relation.dimension(path);
  });
  if (projections.some(p => p.group && !fields.some(f => f.name === p.group))) {
    invalid('Include an aggregate and GROUP BY each non-aggregate projected column.');
  }
  if (new Set(fields.map(f => f.name)).size !== fields.length) invalid();
  return fields.length ? ` GROUP BY ${fields.map(f => f.sql).join(', ')}` : '';
}
function resolveOrders(plan: Select, relation: Relation, projections: Output[]) {
  const seen = new Set<number>();
  const orders = plan.orders.map(({ expr, direction }) => {
    // ORDER BY prefers the output alias; otherwise match a resolved projected expression.
    let index = expr.fn === null && expr.path.length === 1 ? projections.findIndex(p => p.name === expr.path[0]) : -1;
    if (index === -1) {
      const sql = relation.output(expr).sql;
      index = projections.findIndex(p => p.sql === sql);
    }
    if (index < 0 || seen.has(index)) invalid('Order by a projected expression or its unique output alias.');
    seen.add(index);
    return `v${index} ${direction}`;
  });
  // Tie-break on remaining projected native values, never a hidden ID. Rows tied on every
  // projected value may tie physically (including equal decimals with different scales); this
  // is a bounded sample, not stable cursor pagination. Never sort wire strings (100 before 20).
  for (let i = 0; i < projections.length; i++) if (!seen.has(i)) orders.push(`v${i} ASC`);
  return ` ORDER BY ${orders.join(', ')}`;
}

function wireCell(type: AnalyticsResultType, index: number) {
  const ref = `page.v${index}`;
  if (type === 'timestamptz') return `pg_catalog.to_char(pg_catalog.timezone('UTC'::pg_catalog.text, ${ref}), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
  if (type === 'date') return `pg_catalog.to_char(${ref}::pg_catalog.timestamp, 'YYYY-MM-DD')`;
  return `${ref}::pg_catalog.text`;
}

/** Pure compilation except for the per-execution response nonce. Only `dataset` may contain
 * server-owned SQL. Never deserialize it from provider/model input. No database or provider IO. */
export function compileAnalyticsSelect(query: unknown, parameters: unknown, dataset: AnalyticsDataset): CompiledAnalyticsSelect {
  const plan = parseSelect(query);
  const source = plan.relation[plan.relation.length - 1];
  if ((plan.relation.length === 2 && plan.relation[0] !== 'analytics') || !Object.hasOwn(dataset.sources, source)) {
    invalid('Select one listed analytics source, unqualified or in the analytics schema.');
  }
  const src = dataset.sources[source];
  if (!src?.sql || !src.guardSql) invalid();
  const relation = new Relation(source, plan.alias, src);
  const outputs = plan.projections.map(p => relation.output(p.expr, p.alias));
  if (new Set(outputs.map(o => o.name)).size !== outputs.length) invalid('Give every projected column a unique, simple alias.');
  const binds = new Bindings(dataset.parameters, parameters);
  const filter = plan.where ? relation.predicate(plan.where, binds) : undefined;
  const where = filter ? ` WHERE ${filter.sql}` : '';
  const group = resolveGroups(plan, relation, outputs, Object.hasOwn(dataset, 'allowRows') && dataset.allowRows === true);
  const order = resolveOrders(plan, relation, outputs);
  const money = src.money;
  const projectCurrency = money && outputs.some(p => p.group === money.currency);
  if (outputs.some(p => p.money) && !projectCurrency && !filter?.fixesCurrency) {
    invalid('For monetary aggregates, project and GROUP BY the source currency, or require currency equality to one uppercase three-letter code.');
  }
  // GROUP BY validation above proves a projected currency in an aggregate plan is grouped.
  // NULL (or a noncanonical currency label) is not a unit. Suppress only its money aggregate,
  // not the group or its counts. For the equality-only route no currency group key is needed.
  const currency = projectCurrency && relation.dimension([money.currency]);
  const projection = outputs.map((p, i) => {
    const sql = p.money && currency ? `CASE WHEN ${currency.sql} OPERATOR(pg_catalog.~) '^[A-Z]{3}$' THEN ${p.sql} END` : p.sql;
    return `${sql} AS v${i}`;
  }).join(', ');
  const limit = binds.limit(plan.limit);
  binds.finish();
  const lookahead = binds.bind(String(limit + 1), 'integer');
  const page = `SELECT ${projection} FROM (${src.sql}) AS r${where}${group}${order} LIMIT ${lookahead}`;

  const columns = outputs.map(({ name, type }) => ({ name, type }));
  const cells = columns.map(({ type }, i) => wireCell(type, i));
  const row = columns.map(({ name }, i) => `${binds.bind(name, 'text')}, ${cells[i]}`).join(', ');
  // An oversized value invalidates the row, rather than silently truncating or changing its value.
  const withinBounds = cells.map(s => `(pg_catalog.octet_length(${s}) OPERATOR(pg_catalog.<=) 200) IS NOT FALSE`).join(' AND ');
  const json = `CASE WHEN ${withinBounds} THEN pg_catalog.jsonb_build_object(${row}) END`;
  const attestation = randomUUID();
  const marker = binds.bind(attestation, 'text');
  // CASE guards the *aggregate subquery*, not merely its input rows. A wrong role/guard must not
  // appear as a legitimate empty group or COUNT(*) = 0. An attested empty result is a real [].
  const sql = `SELECT CASE WHEN checked.ok THEN ${marker} END AS analytics_scope,
    CASE WHEN checked.ok THEN (SELECT COALESCE(pg_catalog.jsonb_agg(${json}${order}), '[]'::pg_catalog.jsonb)
      FROM (${page}) AS page) END AS analytics_rows
    FROM (SELECT CURRENT_USER OPERATOR(pg_catalog.=) 'supabase_read_only_user'::pg_catalog.name AND (${src.guardSql}) AS ok) AS checked`;
  return { query: sql, source, parameters: binds.values, columns, limit, attestation };
}
