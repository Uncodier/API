/** Only authorization reads use this retry policy. Never wrap tool execution. */
export const SCREEN_ACCESS_READ_TIMEOUT_MS = 10_000;
export type ScreenAccessReadPhase = 'effective_access' | 'site' | 'roles';
type FailureReason = 'timeout' | 'transport' | 'backend';
type ReadResult<T> = { data: T; error: unknown; status?: number };
const transientCodes = new Set(['57014', '53300', '57P01', '57P02', '57P03', 'PGRST000', 'PGRST001', 'PGRST002', 'PGRST003']);
const permanentCodes = new Set(['42501', '42703', '42P01', '42883', 'PGRST116', 'PGRST202', 'PGRST204', 'PGRST301', 'PGRST302']);

/** No raw error/cause: failed requests can contain credentials, URLs and user data. */
export class ScreenAccessReadError extends Error {
  constructor(readonly phase: ScreenAccessReadPhase, readonly reason: FailureReason,
    readonly retryable: boolean, readonly backendCode?: string) {
    super('Permission lookup failed');
    this.name = 'ScreenAccessReadError';
  }
}

function failure(phase: ScreenAccessReadPhase, error: unknown, status?: number): ScreenAccessReadError {
  const value = error as { code?: unknown; name?: unknown } | null;
  // Only finite known codes enter diagnostics; never include messages or URLs.
  const code = typeof value?.code === 'string' && (transientCodes.has(value.code) || permanentCodes.has(value.code)) ? value.code : undefined;
  const timeout = value?.name === 'AbortError' || value?.name === 'TimeoutError';
  const transport = status === 0 || error instanceof TypeError;
  return new ScreenAccessReadError(phase, timeout ? 'timeout' : transport ? 'transport' : 'backend',
    !(code !== undefined && permanentCodes.has(code)) && (timeout || transport ||
      (code !== undefined && transientCodes.has(code)) ||
      (status !== undefined && [408, 429, 500, 502, 503, 504].includes(status))), code);
}

/** Each dependent stage gets its own deadline; a slow RPC cannot consume the
 * role lookup's time. Promise.race also bounds transports that ignore abort.
 */
export async function readScreenAccess<T>(phase: ScreenAccessReadPhase,
  read: (signal: AbortSignal) => PromiseLike<ReadResult<T>>): Promise<T> {
  const signal = AbortSignal.timeout(SCREEN_ACCESS_READ_TIMEOUT_MS);
  let removeListener = () => {};
  try {
    const aborted = new Promise<never>((_, reject) => {
      const onAbort = () => reject(new ScreenAccessReadError(phase, 'timeout', true));
      signal.addEventListener('abort', onAbort, { once: true });
      removeListener = () => signal.removeEventListener('abort', onAbort);
      if (signal.aborted) onAbort();
    });
    const result = await Promise.race([
      Promise.resolve().then(() => {
        if (signal.aborted) throw new ScreenAccessReadError(phase, 'timeout', true);
        return read(signal);
      }), aborted,
    ]);
    if (signal.aborted) throw new ScreenAccessReadError(phase, 'timeout', true);
    if (result.error) throw failure(phase, result.error, result.status);
    return result.data;
  } catch (error) {
    throw error instanceof ScreenAccessReadError ? error : failure(phase, error);
  } finally { removeListener(); }
}