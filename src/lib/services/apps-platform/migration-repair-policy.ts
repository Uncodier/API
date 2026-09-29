import { splitSqlStatements } from './migration-sql-text';

/** PostgreSQL folds unquoted names only; quoted names and their spacing are exact. */
function normalizePolicyHeader(code: string): string {
  return (code.match(/"(?:[^"]|"")*"|[^"]+/g) || [])
    .map(part => part.startsWith('"') ? part : part.toLowerCase().replace(/\s+/g, ' '))
    .join('').trim();
}

function policyHeader(code: string): string {
  // Do not confuse words inside quoted identifiers with the predicate boundary.
  const unquoted = code.replace(/"(?:[^"]|"")*"/g, quoted => ' '.repeat(quoted.length));
  const predicate = /\b(?:using|with\s+check)\s*\(/i.exec(unquoted);
  return normalizePolicyHeader(predicate ? code.slice(0, predicate.index) : code);
}

/** Conservative repair boundary, not a SQL parser: ambiguous structural/data changes need review. */
export function canAutomaticallyReplaceMigration(original: string, replacement: string): boolean {
  const before = splitSqlStatements(original).filter(stmt => stmt.code.trim());
  const after = splitSqlStatements(replacement).filter(stmt => stmt.code.trim());
  const isPolicy = (code: string) => /^\s*(?:create|alter|drop)\s+policy\b/i.test(code);
  const policyIdentity = (code: string) => {
    const match = code.match(/^\s*(?:create|alter)\s+policy\s+("(?:[^"]|"")+"|\w+)\s+on\s+((?:"(?:[^"]|"")+"|\w+)(?:\s*\.\s*(?:"(?:[^"]|"")+"|\w+))?)/i);
    return match ? normalizePolicyHeader(`${match[1]} ON ${match[2]}`) : null;
  };
  if (!before.length || !after.length) return false;
  // Preserve every non-policy statement byte-for-byte (including data literals).
  // No new DML, DROP COLUMN (COLUMN is optional), constraint removal, or no-op substitution.
  const unchanged = before.filter(stmt => !isPolicy(stmt.code)).map(stmt => stmt.text);
  const proposed = after.filter(stmt => !isPolicy(stmt.code)).map(stmt => stmt.text);
  if (JSON.stringify(unchanged) !== JSON.stringify(proposed)) return false;
  const identities = new Set(after.map(stmt => policyIdentity(stmt.code)).filter(Boolean));
  const originalPolicies = before.map(stmt => policyIdentity(stmt.code)).filter(Boolean);
  if (!originalPolicies.length || identities.size !== new Set(originalPolicies).size ||
      originalPolicies.some(identity => !identities.has(identity))) return false;
  const policyHeaders = (statements: typeof before) => statements
    .filter(stmt => policyIdentity(stmt.code))
    .map(stmt => policyHeader(stmt.code));
  // Predicate repair must not expand FOR SELECT into FOR ALL or change policy roles.
  if (JSON.stringify(policyHeaders(before)) !== JSON.stringify(policyHeaders(after))) return false;
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