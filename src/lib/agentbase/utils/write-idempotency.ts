import crypto from 'crypto';

export const IDEMPOTENCY_KEY_FIELD = 'agentbase_idempotency_key';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      if (key === 'command_id' || key === IDEMPOTENCY_KEY_FIELD) continue;
      out[key] = canonicalize(obj[key]);
    }
    return out;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function buildWriteIdempotencyKey(
  commandId: string,
  tool: string,
  action: string,
  args: Record<string, unknown>
): string {
  const hash = crypto.createHash('sha256').update(canonicalJson(args)).digest('hex').slice(0, 16);
  return `${commandId}:${tool}:${action}:${hash}`;
}

export function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}
