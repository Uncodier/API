import { invalid } from './supabase-select-diagnostics';
import type { Literal } from './supabase-select-parser';
import type { AnalyticsResultType } from './supabase-select-types';

// Leave decimals as strings. In particular, do not use Number() on numeric literals, INT8 or money.
const money = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const integer = /^-?(?:0|[1-9]\d*)$/;
const date = /^(\d{4})-(\d{2})-(\d{2})$/;
const instant = /^(\d{4}-\d{2}-\d{2})[T ](?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/;
const badValue = () => invalid('value');

function validDate(s: string) {
  const m = date.exec(s);
  if (!m) return false;
  const [y, month, day] = m.slice(1).map(Number);
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return y >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}
function validInt8(s: string) {
  if (!integer.test(s)) return false;
  const n = s.replace(/^-/, '');
  return n.length < 19 || (n.length === 19 && n <= (s[0] === '-' ? '9223372036854775808' : '9223372036854775807'));
}
function validate(s: unknown, type: AnalyticsResultType) {
  if (typeof s !== 'string' || s.length > 256 || Buffer.byteLength(s) > 256 || /[\x00-\x1f\x7f]/.test(s) ||
      // All user strings must round-trip through the provider's UTF-8 transport.
      /[\uD800-\uDFFF]/u.test(s)) return badValue();
  if (type === 'numeric' && (!money.test(s) || s.length > 128)) return badValue();
  if (type === 'integer' && !validInt8(s)) return badValue();
  if (type === 'boolean' && s !== 'true' && s !== 'false') return badValue();
  if (type === 'date' && !validDate(s)) return badValue();
  if (type === 'timestamptz' && (!instant.test(s) || !validDate(s.slice(0, 10)))) return badValue();
  return s;
}
const cast: Record<AnalyticsResultType, string> = {
  numeric: 'numeric', integer: 'int8', date: 'date', timestamptz: 'timestamptz', text: 'text', boolean: 'bool',
};
export function typed(sql: string, type: AnalyticsResultType) {
  const result = `${sql}::pg_catalog.${cast[type]}`;
  return type === 'text' ? `${result} COLLATE pg_catalog."C"` : result;
}

export class Bindings {
  readonly values: string[];
  private readonly args: unknown[];
  private used = new Map<number, AnalyticsResultType>();
  constructor(prefix: readonly string[], args: unknown) {
    this.values = [...prefix];
    if (args === undefined) this.args = [];
    else if (Array.isArray(args) && args.length <= 16) this.args = args;
    else invalid('parameters');
  }
  bind(s: string, type: AnalyticsResultType) { return typed(`$${this.values.push(s)}`, type); }
  private value(literal: Literal, type: AnalyticsResultType): string {
    let value: unknown = literal.value;
    if (literal.kind === 'parameter') {
      const n = Number(literal.value);
      if (n < 1 || n > this.args.length || !Object.hasOwn(this.args, n - 1) ||
          (this.used.has(n) && this.used.get(n) !== type)) invalid('bind');
      this.used.set(n, type);
      value = this.args[n - 1]; // Never index the trusted parameter prefix with a caller placeholder.
      if (type === 'boolean' && typeof value === 'boolean') value = String(value);
      if ((type === 'numeric' || type === 'integer') && typeof value === 'number' && Number.isSafeInteger(value)) value = String(value);
    } else {
      const compatible = literal.kind === type || (literal.kind === 'string' && ['text', 'date', 'timestamptz'].includes(type)) ||
        (literal.kind === 'number' && (type === 'numeric' || type === 'integer'));
      if (!compatible) return badValue();
    }
    return validate(value, type);
  }
  comparison(literal: Literal, type: AnalyticsResultType) {
    const value = this.value(literal, type);
    return { value, sql: this.bind(value, type) };
  }
  limit(literal?: Literal) {
    const n = literal ? Number(this.value(literal, 'integer')) : 25;
    if (!Number.isInteger(n) || n < 1 || n > 25) invalid('limit');
    return n;
  }
  finish() {
    if (this.used.size !== this.args.length) invalid('unusedBind');
  }
}
