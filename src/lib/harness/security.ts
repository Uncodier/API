import { createHash } from 'node:crypto';

/** Host-only known values augment pattern redaction; never serialize the list. */
export function createRedactor(secrets: string[] = []): (text: string) => string {
  const values = [...new Set(secrets.filter(value => value.length > 0))].sort((a, b) => b.length - a.length);
  return text => {
    let safe = text;
    for (const value of values) {
      safe = safe.split(value).join('[REDACTED]');
      safe = safe.split(encodeURIComponent(value)).join('[REDACTED]');
      safe = safe.split(JSON.stringify(value).slice(1, -1)).join('[REDACTED]');
    }
    return safe
      .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[REDACTED]@')
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
      .replace(/([?&](?:access_token|refresh_token|api_key|secret|signature|password)=)[^&\s"\\]+/gi, '$1[REDACTED]')
      .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_JWT]');
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

export function operationFingerprint(name: string, args: unknown): string {
  return createHash('sha256').update(JSON.stringify([name, canonical(args)])).digest('hex');
}

export function safeError(error: unknown, redact: (text: string) => string): string {
  return redact(error instanceof Error ? error.message : String(error)).slice(0, 2000);
}

export function redactData<T>(value: T, redact: (text: string) => string): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map(item => redactData(item, redact)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [redact(key), redactData(item, redact)])) as T;
  return value;
}

/** Text admission is stricter than code/tool arguments: users must configure credentials on the host. */
export function redactUserText(value: string): string {
  return createRedactor()(value).replace(
    /\b(password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
    '$1=[REDACTED]',
  );
}

/** Public settings still belong to the host, but redacting CI=1 must not erase every digit. */
export function runtimeSecretValues(values: Record<string, string>): string[] {
  return Object.entries(values).filter(([name]) =>
    /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE|API_KEY|JWT|DATABASE_URL|CONNECTION_STRING)/i.test(name))
    .map(([, value]) => value).filter(Boolean);
}

/** A trusted adapter can prove it failed before sending an effect to a provider. */
export class BeforeEffectError extends Error {
  readonly effectStarted = false;
}