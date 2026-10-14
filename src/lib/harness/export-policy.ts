import ts from 'typescript';

const sensitiveName = /(?:password|passwd|secret|token|credential|authorization|cookie|(?:^|[_-])(?:api|private|access)[_-]?key|database[_-]?url|connection[_-]?string)/i;

/** Conservative export inspection, NOT a guarantee that arbitrary source has no secrets. */
export function sourceExportRisk(path: string, content: string, redact: (text: string) => string): string | null {
  if (content.includes('[REDACTED') || redact(content) !== content) return 'recognized_credential';
  if (/-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----/i.test(content)) return 'private_key';
  if (/\b(?:sk_(?:live|test)_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|sb_secret_[A-Za-z0-9_-]{16,})\b/.test(content)) return 'provider_credential';
  if (/\.json$/i.test(path)) {
    let value: unknown;
    try { value = JSON.parse(content); } catch { return 'unparseable_configuration'; }
    const inspect = (item: unknown, key = '', depth = 0): boolean => {
      if (depth > 40) return true;
      if (sensitiveName.test(key) && typeof item === 'string' && item.trim()) return true;
      if (Array.isArray(item)) return item.some(child => inspect(child, key, depth + 1));
      return !!item && typeof item === 'object' && Object.entries(item).some(([name, child]) => inspect(child, name, depth + 1));
    };
    if (inspect(value)) return 'sensitive_configuration_value';
  }
  if (/\.[cm]?[jt]sx?$/i.test(path)) {
    const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true,
      /x$/i.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    let unsafe = false;
    const literal = (node: ts.Node): boolean => ts.isStringLiteralLike(node) ? node.text.length > 0
      : ts.isBinaryExpression(node) ? literal(node.left) || literal(node.right)
        : ts.isParenthesizedExpression(node) ? literal(node.expression) : false;
    const visit = (node: ts.Node) => {
      if ((ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) && node.initializer &&
        sensitiveName.test(node.name.getText(source)) && literal(node.initializer)) unsafe = true;
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (unsafe) return 'sensitive_source_literal';
  }
  // JSON/YAML/TOML/dotenv/docs assignments, including quoted keys and prefixed names.
  const assignment = /(?:["']?)([A-Za-z_][A-Za-z0-9_.-]*)(?:["']?)\s*[:=]\s*(?:["']([^"'\r\n]+)["']|([^\s,;}\r\n]+))/g;
  for (const match of content.matchAll(assignment)) {
    if (!sensitiveName.test(match[1])) continue;
    const value = match[2] ?? match[3];
    if (/^(?:process\.env\.|import\.meta\.env\.|os\.(?:getenv|environ)|\$\{|\$[A-Z_]|input\.|settings\.)/.test(value)) continue;
    if (value && !['null', 'undefined', 'false', 'true'].includes(value)) return 'sensitive_assignment';
  }
  return null;
}