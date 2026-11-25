// A queue start (and legacy materialization) has no AbortSignal API. Limit the
// wait without interpreting cancellation as proof that nothing was committed.
export function deadline(parent: AbortSignal, ms: number): AbortSignal {
  return AbortSignal.any([parent, AbortSignal.timeout(ms)]);
}

export function waitFor<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Cron operation interrupted.'));
    signal.addEventListener('abort', abort, { once: true });
    try { work().then(resolve, reject).finally(() => signal.removeEventListener('abort', abort)); }
    catch (error) { signal.removeEventListener('abort', abort); reject(error); }
  });
}
