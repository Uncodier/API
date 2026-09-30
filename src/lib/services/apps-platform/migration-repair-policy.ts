import { changesSqlStringSemantics, maskSqlIdentifiers, splitSqlStatements } from './migration-sql-text';

/** PostgreSQL folds unquoted names only; quoted names and their spacing are exact. */
function normalizePolicyHeader(code: string): string {
  return (code.match(/"(?:[^"]|"")*"|[^"]+/g) || [])
    // Do not guess locale-dependent folding of non-ASCII identifier characters.
    .map(part => part.startsWith('"') ? part : part.replace(/[A-Z]/g, char => char.toLowerCase()).replace(/[ \t\r\n\f\v]+/g, ' '))
    .join('').replace(/^[ \t\r\n\f\v]+|[ \t\r\n\f\v]+$/g, '');
}

function parsePolicy(code: string): { identity: string; header: string } | null {
  // Do not confuse words inside quoted identifiers with the predicate boundary.
  const unquoted = maskSqlIdentifiers(code);
  const predicate = /\b(?:using|with\s+check)\s*\(/i.exec(unquoted);
  const header = predicate ? code.slice(0, predicate.index) : code;
  const identifier = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_$\u0080-\uFFFF]*)`;
  const roles = String.raw`(?:\s+to\s+${identifier}(?:\s*,\s*${identifier})*)?`;
  const match = header.match(new RegExp(
    String.raw`^\s*(create|alter)\s+policy\s+(${identifier})\s+on\s+(${identifier}(?:\s*\.\s*${identifier})?)([\s\S]*)$`, 'i',
  ));
  if (!match) return null;
  const options = match[1].toLowerCase() === 'create'
    ? String.raw`(?:\s+as\s+(?:permissive|restrictive))?(?:\s+for\s+(?:all|select|insert|update|delete))?${roles}`
    : roles;
  if (!new RegExp(`^${options}\\s*$`, 'i').test(match[4])) return null;

  // Only predicates may follow the header. Do not silently discard an ALTER
  // RENAME, a second header, malformed parentheses, or other trailing SQL.
  let tail = predicate ? code.slice(predicate.index).trim() : '';
  let previous = 0;
  while (tail) {
    const unquotedTail = maskSqlIdentifiers(tail);
    const clause = /^(using|with\s+check)\s*\(/i.exec(unquotedTail);
    if (!clause) return null;
    const order = clause[1].toLowerCase() === 'using' ? 1 : 2;
    if (order <= previous) return null;
    previous = order;
    let depth = 1;
    let end = clause[0].length;
    const start = end;
    while (end < tail.length && depth > 0) {
      if (unquotedTail[end] === '(') depth++;
      if (unquotedTail[end] === ')') depth--;
      end++;
    }
    if (depth !== 0 || !tail.slice(start, end - 1).trim()) return null;
    tail = tail.slice(end).trim();
  }
  return { identity: normalizePolicyHeader(`${match[2]} ON ${match[3]}`),
    header: normalizePolicyHeader(header) };
}

/** Conservative repair boundary, not a SQL parser: ambiguous structural/data changes need review. */
export function canAutomaticallyReplaceMigration(original: string, replacement: string): boolean {
  const before = splitSqlStatements(original).filter(stmt => stmt.code.trim());
  const after = splitSqlStatements(replacement).filter(stmt => stmt.code.trim());
  const isPolicy = (code: string) => /^\s*(?:create|alter|drop)\s+policy\b/i.test(code);
  if (!before.length || !after.length) return false;
  if ([...before, ...after].some(stmt => stmt.parseError || changesSqlStringSemantics(stmt.code))) return false;
  // Preserve every non-policy statement byte-for-byte (including data literals).
  // No new DML, DROP COLUMN (COLUMN is optional), constraint removal, or no-op substitution.
  const unchanged = before.filter(stmt => !isPolicy(stmt.code)).map(stmt => stmt.text);
  const proposed = after.filter(stmt => !isPolicy(stmt.code)).map(stmt => stmt.text);
  if (JSON.stringify(unchanged) !== JSON.stringify(proposed)) return false;
  const policies = (statements: typeof before) => statements
    .filter(stmt => /^\s*(?:create|alter)\s+policy\b/i.test(stmt.code))
    .map(stmt => parsePolicy(stmt.code));
  const originalPolicies = policies(before);
  const proposedPolicies = policies(after);
  // Never filter out failed parses: one unknown policy invalidates the entire repair.
  if (!originalPolicies.length || [...originalPolicies, ...proposedPolicies].some(policy => !policy)) return false;
  // Predicate repair must not expand FOR SELECT into FOR ALL or change policy roles.
  if (JSON.stringify(originalPolicies) !== JSON.stringify(proposedPolicies)) return false;
  const drops = (statements: typeof before) => statements
    .filter(stmt => /^\s*drop\s+policy\b/i.test(stmt.code)).map(stmt => stmt.text);
  if (JSON.stringify(drops(before)) !== JSON.stringify(drops(after))) return false;
  return true;
}

export function sanitizeMigrationRepairContext(content: string): string {
  return content
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sb_secret_[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+)\b/g, '[REDACTED_KEY]')
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/(\b[\w]*(?:token|password|secret|api_key|service_key|service_role_key)[\w]*["']?\s*[:=]\s*["'`])[^"'`\n]*(["'`])/gi, '$1[REDACTED]$2');
}