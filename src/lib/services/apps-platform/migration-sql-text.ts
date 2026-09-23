export interface SqlStatement {
  text: string;
  /** SQL code with comments and non-executable literals replaced by spaces. */
  code: string;
  line: number;
}

function dollarTagAt(sql: string, offset: number): string | null {
  const match = sql.slice(offset).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
  return match?.[0] ?? null;
}

function masked(value: string): string {
  return value.replace(/[^\n]/g, ' ');
}

function maskSql(
  sql: string,
  preserveDollarBody: boolean,
): string {
  let output = '';
  let i = 0;

  while (i < sql.length) {
    const char = sql[i];
    const next = sql[i + 1];

    if (char === '-' && next === '-') {
      const end = sql.indexOf('\n', i + 2);
      const stop = end === -1 ? sql.length : end;
      output += masked(sql.slice(i, stop));
      i = stop;
      continue;
    }

    if (char === '/' && next === '*') {
      let depth = 1;
      let end = i + 2;
      while (end < sql.length && depth > 0) {
        if (sql[end] === '/' && sql[end + 1] === '*') {
          depth++;
          end += 2;
        } else if (sql[end] === '*' && sql[end + 1] === '/') {
          depth--;
          end += 2;
        } else {
          end++;
        }
      }
      output += masked(sql.slice(i, end));
      i = end;
      continue;
    }

    if (char === "'") {
      let end = i + 1;
      while (end < sql.length) {
        if (sql[end] === "'" && sql[end + 1] === "'") {
          end += 2;
          continue;
        }
        if (sql[end] === "'" && sql[end - 1] === '\\') {
          end++;
          continue;
        }
        if (sql[end] === "'") {
          end++;
          break;
        }
        end++;
      }
      const closed = sql[end - 1] === "'";
      output += "'";
      output += masked(sql.slice(i + 1, closed ? end - 1 : end));
      if (closed) output += "'";
      i = end;
      continue;
    }

    if (char === '$') {
      const tag = dollarTagAt(sql, i);
      if (tag) {
        const bodyStart = i + tag.length;
        const closing = sql.indexOf(tag, bodyStart);
        const bodyEnd = closing === -1 ? sql.length : closing;
        const end = closing === -1 ? sql.length : closing + tag.length;
        output += masked(tag);
        output += preserveDollarBody
          ? maskSql(sql.slice(bodyStart, bodyEnd), false)
          : masked(sql.slice(bodyStart, bodyEnd));
        if (closing !== -1) output += masked(tag);
        i = end;
        continue;
      }
    }

    output += char;
    i++;
  }

  return output;
}

function analyzableSql(sql: string): string {
  const outerCode = maskSql(sql, false);
  const hasExecutableDollarBody =
    /\bcreate\s+(?:or\s+replace\s+)?(?:function|procedure)\b/i.test(
      outerCode,
    ) ||
    /^\s*do\b/i.test(outerCode);
  return maskSql(sql, hasExecutableDollarBody);
}

export function splitSqlStatements(sql: string): SqlStatement[] {
  const statements: SqlStatement[] = [];
  let buffer = '';
  let line = 1;
  let startLine = 1;
  let state: 'normal' | 'single' | 'double' | 'line' | 'block' | 'dollar' =
    'normal';
  let blockDepth = 0;
  let dollarTag = '';

  const flush = () => {
    const text = buffer.trim();
    if (text) statements.push({ text, code: analyzableSql(text), line: startLine });
    buffer = '';
  };

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    const next = sql[i + 1];
    if (char === '\n') line++;

    if (state === 'line') {
      buffer += char;
      if (char === '\n') state = 'normal';
      continue;
    }
    if (state === 'block') {
      buffer += char;
      if (char === '/' && next === '*') {
        buffer += next;
        blockDepth++;
        i++;
      } else if (char === '*' && next === '/') {
        buffer += next;
        blockDepth--;
        i++;
        if (blockDepth === 0) state = 'normal';
      }
      continue;
    }
    if (state === 'single' || state === 'double') {
      buffer += char;
      const quote = state === 'single' ? "'" : '"';
      if (char === quote && next === quote) {
        buffer += next;
        i++;
      } else if (char === quote && sql[i - 1] !== '\\') {
        state = 'normal';
      }
      continue;
    }
    if (state === 'dollar') {
      if (sql.startsWith(dollarTag, i)) {
        buffer += dollarTag;
        i += dollarTag.length - 1;
        state = 'normal';
      } else {
        buffer += char;
      }
      continue;
    }

    if (char === '-' && next === '-') {
      buffer += '--';
      i++;
      state = 'line';
      continue;
    }
    if (char === '/' && next === '*') {
      buffer += '/*';
      i++;
      blockDepth = 1;
      state = 'block';
      continue;
    }
    if (char === "'" || char === '"') {
      buffer += char;
      state = char === "'" ? 'single' : 'double';
      continue;
    }
    if (char === '$') {
      const tag = dollarTagAt(sql, i);
      if (tag) {
        buffer += tag;
        i += tag.length - 1;
        dollarTag = tag;
        state = 'dollar';
        continue;
      }
    }
    if (char === ';') {
      flush();
      startLine = line;
      continue;
    }
    if (!buffer.trim() && /\s/.test(char)) {
      startLine = line;
    }
    buffer += char;
  }

  flush();
  return statements;
}
