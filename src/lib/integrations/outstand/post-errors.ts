/** Only errors constructed here may cross the HTTP boundary. */
export class OutstandPostError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'OutstandPostError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function upstreamStatus(error: unknown): number | undefined {
  if (!isObject(error)) return undefined;
  return typeof error.upstreamStatus === 'number' ? error.upstreamStatus
    : typeof error.status === 'number' ? error.status : undefined;
}