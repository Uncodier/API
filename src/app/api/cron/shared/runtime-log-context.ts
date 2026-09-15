const MAX_LOG_CHARS = 4_000;
const MAX_LOG_LINES = 50;

const IMPORTANT_LINE =
  /(error|warn(?:ing)?|exception|rejection|failed|failure|fatal|stack|status\s*5\d\d)|^\s*at\s+/i;

function redactSecrets(value: string): string {
  return value
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(
      /(["'](?:authorization|cookie|set-cookie|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)["']\s*:\s*["'])[^"']+(["'])/gi,
      '$1[REDACTED]$2',
    )
    .replace(
      /\b(authorization|cookie|set-cookie|x-api-key)\b(\s*[:=]\s*)[^\r\n]+/gi,
      '$1$2[REDACTED]',
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\b(\s*[:=]\s*)([^\s,;]+)/gi,
      '$1$2[REDACTED]',
    )
    .replace(
      /\b(eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g,
      '[REDACTED_JWT]',
    )
    .replace(
      /([?&](?:token|key|secret|signature|password)=)[^&\s]+/gi,
      '$1[REDACTED]',
    )
    .replace(
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
      '[REDACTED_EMAIL]',
    );
}

function selectPertinentLines(lines: string[]): string[] {
  const selected = new Set<number>();
  lines.forEach((line, index) => {
    if (!IMPORTANT_LINE.test(line)) return;
    for (let offset = -2; offset <= 2; offset += 1) {
      const candidate = index + offset;
      if (candidate >= 0 && candidate < lines.length) selected.add(candidate);
    }
  });

  if (selected.size === 0) {
    return lines.slice(-MAX_LOG_LINES);
  }

  return Array.from(selected)
    .sort((a, b) => a - b)
    .slice(-MAX_LOG_LINES)
    .map((index) => lines[index]);
}

export function sanitizeRuntimeLog(raw: string | null | undefined): string {
  if (!raw) return '';

  const lines = redactSecrets(raw)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean);
  const excerpt = selectPertinentLines(lines).join('\n');

  if (excerpt.length <= MAX_LOG_CHARS) return excerpt;
  return `…[truncated ${excerpt.length - MAX_LOG_CHARS} earlier chars]\n${excerpt.slice(-MAX_LOG_CHARS)}`;
}
