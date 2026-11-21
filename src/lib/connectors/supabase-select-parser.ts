import { simpleName, tokenize, type Token } from './supabase-select-lexer';
import { invalid } from './supabase-select-diagnostics';

export type Aggregate = 'count' | 'count_distinct' | 'sum' | 'avg' | 'min' | 'max';
export type Expr = { fn: Aggregate | 'month' | null; path: string[] };
type ClauseKey = Expr | { position: number };
export type Literal = { kind: 'string' | 'number' | 'boolean' | 'parameter' | 'date' | 'timestamptz'; value: string };
export type Predicate = { kind: 'comparison'; path: string[]; op: string; rhs: Literal }
  | { kind: 'null'; path: string[]; negated: boolean }
  | { kind: 'and' | 'or'; left: Predicate; right: Predicate };
export interface Select {
  projections: { expr: Expr; alias?: string }[];
  relation: string[];
  alias?: string;
  where?: Predicate;
  groups: ClauseKey[];
  orders: { key: ClauseKey; direction: 'ASC' | 'DESC' }[];
  limit?: Literal;
}

// Grammar terminals are not bare identifiers (quoted simple lowercase names can disambiguate).
const terminals = new Set(('select from as where group by order limit and or is not null asc desc ' +
  'distinct true false').split(' '));

class Parser {
  private at = 0;
  private tests = 0;
  constructor(private readonly tokens: Token[]) {}
  private peek() { return this.tokens[this.at]; }
  private take(kind: Token['kind'], text: string) {
    const t = this.peek();
    if (t.kind !== kind || t.value !== text) return false;
    ++this.at;
    return true;
  }
  private word(s: string) { return this.take('word', s); }
  private symbol(s: string) { return this.take('symbol', s); }
  private expect(s: string) { if (!this.word(s)) invalid(); }
  private isName() {
    const t = this.peek();
    return (t.kind === 'identifier' || (t.kind === 'word' && !terminals.has(t.value))) && simpleName(t.value);
  }
  private name() {
    if (!this.isName()) invalid('name');
    return this.tokens[this.at++].value;
  }
  private path(max: number) {
    const parts = [this.name()];
    while (this.symbol('.')) {
      if (parts.length >= max) invalid();
      parts.push(this.name());
    }
    return parts;
  }
  private alias() { return (this.word('as') || this.isName()) ? this.name() : undefined; }
  private expression(): Expr {
    const t = this.peek();
    const next = this.tokens[this.at + 1];
    if (t.kind !== 'word' || next?.kind !== 'symbol' || next.value !== '(') {
      return { fn: null, path: this.path(3) };
    }
    this.at += 2;
    if (t.value === 'date_trunc') {
      if (!this.take('string', 'month') || !this.symbol(',')) invalid('month');
      const path = this.path(3);
      if (!this.symbol(')')) invalid('month');
      return { fn: 'month', path };
    }
    if (!['sum', 'avg', 'min', 'max', 'count'].includes(t.value)) invalid();
    let fn = t.value as Aggregate;
    let path: string[] = [];
    if (!(fn === 'count' && this.symbol('*'))) {
      if (fn === 'count') { this.expect('distinct'); fn = 'count_distinct'; }
      path = this.path(3);
    }
    if (!this.symbol(')')) invalid();
    return { fn, path };
  }
  private clauseKey(width: number): ClauseKey {
    const t = this.peek();
    if (t.kind !== 'number' && t.kind !== 'parameter') return this.expression();
    // Resolve positions against the validated projection, never as free-standing SQL numbers.
    if (t.kind !== 'number' || !/^[1-5]$/.test(t.value) || Number(t.value) > width) invalid('ordinal');
    this.at++;
    return { position: Number(t.value) };
  }
  private literal(): Literal {
    const t = this.tokens[this.at++];
    if (t.kind === 'string' || t.kind === 'number' || t.kind === 'parameter') return { kind: t.kind, value: t.value };
    if (t.kind === 'word') {
      if (t.value === 'true' || t.value === 'false') return { kind: 'boolean', value: t.value };
      if (t.value === 'date' || t.value === 'timestamptz') {
        const value = this.tokens[this.at++];
        if (value.kind === 'string') return { kind: t.value, value: value.value };
      }
    }
    invalid('comparison');
  }
  private atom(depth: number): Predicate {
    if (this.symbol('(')) {
      if (depth >= 5) invalid();
      const p = this.disjunction(depth + 1);
      if (!this.symbol(')')) invalid();
      return p;
    }
    if (++this.tests > 16) invalid();
    const path = this.path(3);
    if (this.word('is')) {
      const negated = this.word('not');
      this.expect('null');
      return { kind: 'null', path, negated };
    }
    const op = this.tokens[this.at++];
    if (op.kind !== 'symbol' || !['=', '<>', '!=', '>', '>=', '<', '<='].includes(op.value)) invalid();
    return { kind: 'comparison', path, op: op.value === '!=' ? '<>' : op.value, rhs: this.literal() };
  }
  private conjunction(depth: number) {
    let p = this.atom(depth);
    while (this.word('and')) p = { kind: 'and', left: p, right: this.atom(depth) };
    return p;
  }
  private disjunction(depth: number): Predicate {
    let p = this.conjunction(depth);
    while (this.word('or')) p = { kind: 'or', left: p, right: this.conjunction(depth) };
    return p;
  }
  private list<T>(item: () => T) {
    const items = [item()];
    while (this.symbol(',')) {
      if (items.length === 5) invalid('width');
      items.push(item());
    }
    return items;
  }
  private by<T>(word: string, item: () => T) {
    if (!this.word(word)) return [];
    this.expect('by');
    return this.list(item);
  }
  parse(): Select {
    this.expect('select');
    const projections = this.list(() => ({ expr: this.expression(), alias: this.alias() }));
    this.expect('from');
    const relation = this.path(2), alias = this.alias();
    const where = this.word('where') ? this.disjunction(0) : undefined;
    const key = () => this.clauseKey(projections.length);
    const groups = this.by('group', key);
    const orders = this.by('order', () => {
      const orderKey = key();
      if (this.word('desc')) return { key: orderKey, direction: 'DESC' as const };
      this.word('asc');
      return { key: orderKey, direction: 'ASC' as const };
    });
    const limit = this.word('limit') ? this.literal() : undefined;
    this.symbol(';');
    if (this.peek().kind !== 'eof') invalid();
    return { projections, relation, alias, where, groups, orders, limit };
  }
}

export function parseSelect(query: unknown): Select { return new Parser(tokenize(query)).parse(); }
