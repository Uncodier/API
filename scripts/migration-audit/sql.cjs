'use strict';

/** Lex SQL without treating quoted text, comments or function bodies as DDL. */
function tokenize(sql) {
  const tokens = [];
  let i = 0;
  while (i < sql.length) {
    if (/\s/.test(sql[i])) { i++; continue; }
    if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i + 2);
      i = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith('/*', i)) {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth) {
        if (sql.startsWith('/*', i)) { depth++; i += 2; }
        else if (sql.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
      if (depth) throw new Error('Unterminated SQL comment');
      continue;
    }
    const start = i;
    if (sql[i] === "'" || sql[i] === '"') {
      const quote = sql[i++];
      let closed = false;
      const escaped = quote === "'" && /\b[eE]$/.test(sql.slice(0, start));
      while (i < sql.length) {
        if (escaped && sql[i] === '\\') { i += 2; continue; }
        if (sql[i++] === quote) {
          if (sql[i] === quote) { i++; continue; }
          closed = true;
          break;
        }
      }
      if (!closed) throw new Error('Unterminated SQL quote');
      tokens.push({ kind: quote === '"' ? 'identifier' : 'string', value: sql.slice(start, i), start, end: i });
      continue;
    }
    const dollar = sql.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/);
    if (dollar) {
      const tag = dollar[0];
      const end = sql.indexOf(tag, i + tag.length);
      if (end < 0) throw new Error('Unterminated SQL dollar quote');
      i = end + tag.length;
      tokens.push({ kind: 'body', value: sql.slice(start + tag.length, end), start, end: i });
      continue;
    }
    const word = sql.slice(i).match(/^[A-Za-z_][A-Za-z_0-9$]*/);
    if (word) {
      i += word[0].length;
      tokens.push({ kind: 'word', value: word[0].toLowerCase(), start, end: i });
      continue;
    }
    i++;
    tokens.push({ kind: 'symbol', value: sql[start], start, end: i });
  }
  return tokens;
}

function statements(sql) {
  const tokens = tokenize(sql);
  const result = [];
  let start = 0;
  for (const token of tokens) {
    if (token.kind === 'symbol' && token.value === ';') {
      result.push(sql.slice(start, token.end));
      start = token.end;
    }
  }
  if (tokenize(sql.slice(start)).length) result.push(sql.slice(start));
  return result;
}

/** Only comments, whitespace and unquoted identifier/keyword case are ignored. */
function canonical(sql) {
  return JSON.stringify(tokenize(sql).map(({ kind, value }) => [kind, value]));
}

function identifier(token) {
  if (!token || !['word', 'identifier'].includes(token.kind)) throw new Error('Expected SQL identifier');
  return token.kind === 'identifier' ? token.value.slice(1, -1).replaceAll('""', '"') : token.value;
}

function functionDefinitions(sql) {
  const result = [];
  for (const statement of statements(sql)) {
    const tokens = tokenize(statement);
    let i = 0;
    if (tokens[i++]?.value !== 'create') continue;
    if (tokens[i]?.value === 'or') {
      if (tokens[++i]?.value !== 'replace') continue;
      i++;
    }
    if (tokens[i++]?.value !== 'function') continue;
    let schema = 'public';
    let name = identifier(tokens[i++]);
    if (tokens[i]?.value === '.') {
      i++;
      schema = name;
      name = identifier(tokens[i++]);
    }
    if (tokens[i++]?.value !== '(') throw new Error('Malformed CREATE FUNCTION');
    let depth = 1;
    const argumentStart = i;
    while (i < tokens.length && depth) {
      if (tokens[i].value === '(') depth++;
      if (tokens[i].value === ')') depth--;
      i++;
    }
    if (depth) throw new Error('Unterminated function arguments');
    const argumentsText = tokens.slice(argumentStart, i - 1).map(t => t.value).join(' ');
    const as = tokens.findIndex((t, n) => n >= i && t.value === 'as' && t.kind === 'word');
    const body = tokens[as + 1];
    // C-language/extension functions and string-body forms require manual review.
    if (as < 0 || body?.kind !== 'body') continue;
    result.push({ schema, name, arguments: argumentsText, body: body.value, statement });
  }
  return result;
}

module.exports = { tokenize, statements, canonical, functionDefinitions };