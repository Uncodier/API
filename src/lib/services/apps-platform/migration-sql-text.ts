export interface SqlStatement {
  text: string;
  /** SQL code with comments and non-executable literals replaced by spaces. */
  code: string;
  line: number;
  /** Ambiguous input must be rejected, never treated as an empty/comment-only statement. */
  parseError?: string;
}

interface SqlToken {
  kind: 'code' | 'string' | 'identifier' | 'comment' | 'dollar';
  start: number;
  end: number;
  quoteOffset?: number;
  tag?: string;
  error?: string;
}

const identifierPart = /[A-Za-z0-9_$\u0080-\uFFFF]/;

function masked(value: string): string {
  return value.replace(/[^\r\n]/g, ' ');
}

// PostgreSQL concatenates strings separated by whitespace containing a newline
// (including line comments). Continuations of E'' retain escape-string semantics.
function stringContinuation(sql: string, offset: number): number | null {
  let end = offset;
  while (end < sql.length) {
    if (/[ \t\r\n\f\v]/.test(sql[end])) end++;
    else if (sql.startsWith('--', end)) {
      while (end < sql.length && !/[\r\n]/.test(sql[end])) end++;
    } else break;
  }
  return sql[end] === "'" && /[\r\n]/.test(sql.slice(offset, end)) ? end : null;
}

/** One lexer for both splitting and masking, fixed to standard_conforming_strings=on. */
function sqlTokens(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let i = 0;
  while (i < sql.length) {
    const start = i;
    if (sql.startsWith('--', i)) {
      while (i < sql.length && !/[\r\n]/.test(sql[i])) i++;
      tokens.push({ kind: 'comment', start, end: i });
    } else if (sql.startsWith('/*', i)) {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql.startsWith('/*', i)) { depth++; i += 2; }
        else if (sql.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
      tokens.push({ kind: 'comment', start, end: i,
        ...(depth ? { error: 'Unterminated block comment.' } : {}) });
    } else if (sql[i] === "'" || sql[i] === '"' ||
        /^[eE]'/.test(sql.slice(i, i + 2)) || /^[uU]&['"]/.test(sql.slice(i, i + 3))) {
      const escape = /^[eE]'/.test(sql.slice(i, i + 2));
      const unicode = /^[uU]&['"]/.test(sql.slice(i, i + 3));
      const quoteOffset = i + (escape ? 1 : unicode ? 2 : 0);
      const quote = sql[quoteOffset];
      let closed = false;
      i = quoteOffset + 1;
      while (i < sql.length) {
        // Only E strings escape the next character. Neither ordinary strings
        // nor quoted identifiers treat a backslash before a quote specially.
        if (escape && sql[i] === '\\') { i = Math.min(i + 2, sql.length); continue; }
        if (sql[i] !== quote) { i++; continue; }
        if (sql[i + 1] === quote) { i += 2; continue; }
        i++;
        const continuation = quote === "'" ? stringContinuation(sql, i) : null;
        if (continuation !== null) { i = continuation + 1; continue; }
        closed = true;
        break;
      }
      const error = !closed ? 'Unterminated quoted SQL token.' :
        unicode && quote === '"' ? 'Unicode-escaped identifiers require manual review.' :
        quote === '"' && i === quoteOffset + 2 ? 'Empty quoted identifier.' : undefined;
      tokens.push({ kind: quote === '"' ? 'identifier' : 'string', start, end: i,
        quoteOffset, ...(error ? { error } : {}) });
    } else if (sql[i] === '$' && /^\$(?:[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\u0080-\uFFFF]*)?\$/.test(sql.slice(i))) {
      const tag = sql.slice(i).match(/^\$(?:[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\u0080-\uFFFF]*)?\$/)![0];
      const closing = sql.indexOf(tag, i + tag.length);
      i = closing === -1 ? sql.length : closing + tag.length;
      tokens.push({ kind: 'dollar', start, end: i, tag,
        ...(closing === -1 ? { error: 'Unterminated dollar-quoted string.' } : {}) });
    } else {
      i++;
      // Consume the whole word: E and dollar tags embedded in an unquoted
      // identifier are not the start of a quoted string.
      if (identifierPart.test(sql[start])) {
        while (i < sql.length && identifierPart.test(sql[i])) i++;
      }
      tokens.push({ kind: 'code', start, end: i,
        ...(sql[start] === '\0' ? { error: 'NUL is not valid SQL text.' } : {}) });
    }
  }
  return tokens;
}

/** Hide identifiers only where looking for keywords/parentheses, retaining offsets. */
export function maskSqlIdentifiers(code: string): string {
  return code.replace(/"(?:[^"]|"")*"/g, masked);
}

/** These settings cannot change the lexer's fixed, runner-owned string semantics. */
export function changesSqlStringSemantics(code: string): boolean {
  return /\b(?:set(?:\s+(?:local|session))?|reset)\s+(?:"standard_conforming_strings"|standard_conforming_strings\b)/i.test(code) ||
    /\breset\s+all\b/i.test(code) || /\bset_config"?\s*\(/i.test(code);
}

function maskSql(sql: string, preserveDollarBody: boolean): { code: string; error?: string } {
  let error: string | undefined;
  const code = sqlTokens(sql).map(token => {
    error ||= token.error;
    const value = sql.slice(token.start, token.end);
    if (token.kind === 'comment') return masked(value);
    if (token.kind === 'string') {
      const prefix = sql.slice(token.start, token.quoteOffset);
      return prefix + "'" + masked(sql.slice(token.quoteOffset! + 1, token.end - 1)) + "'";
    }
    if (token.kind === 'dollar') {
      const tag = token.tag!;
      if (!preserveDollarBody || token.error) return masked(value);
      const body = maskSql(value.slice(tag.length, -tag.length), false);
      error ||= body.error;
      return masked(tag) + body.code + masked(tag);
    }
    // Preserve identifiers exactly, including apostrophes, comment markers,
    // dollar tags, doubled double quotes, case and significant whitespace.
    return value;
  }).join('');
  return { code, error };
}

function analyzableSql(sql: string): { code: string; error?: string } {
  const outer = maskSql(sql, false);
  const keywords = maskSqlIdentifiers(outer.code);
  if (/^\s*(?:create\s+(?:or\s+replace\s+)?(?:function|procedure)|do)\b/i.test(keywords)) {
    return maskSql(sql, true);
  }
  return outer;
}

export function splitSqlStatements(sql: string): SqlStatement[] {
  const statements: SqlStatement[] = [];
  let start = 0;
  let line = 1;
  let depth = 0;
  let error: string | undefined;
  const flush = (end: number) => {
    const raw = sql.slice(start, end);
    // JavaScript trim() also removes non-ASCII characters that PostgreSQL can
    // treat as part of an unquoted identifier (for example NBSP).
    const text = raw.replace(/^[ \t\r\n\f\v]+|[ \t\r\n\f\v]+$/g, '');
    if (text) {
      const analysis = analyzableSql(text);
      const parseError = error || analysis.error || (raw.includes('\0') ? 'NUL is not valid SQL text.' : undefined) ||
        (depth !== 0 ? 'Unbalanced SQL parentheses.' : undefined);
      const leading = raw.slice(0, raw.indexOf(text));
      statements.push({ text, code: parseError ? text : analysis.code,
        line: line + (leading.match(/\n/g) || []).length,
        ...(parseError ? { parseError } : {}) });
    }
    line += (raw.match(/\n/g) || []).length;
    start = end + 1;
    depth = 0;
    error = undefined;
  };
  for (const token of sqlTokens(sql)) {
    error ||= token.error;
    if (token.kind !== 'code') continue;
    const value = sql.slice(token.start, token.end);
    if (value === '(') depth++;
    if (value === ')' && --depth < 0) error ||= 'Unbalanced SQL parentheses.';
    if (value === ';') flush(token.start);
  }
  flush(sql.length);
  return statements;
}