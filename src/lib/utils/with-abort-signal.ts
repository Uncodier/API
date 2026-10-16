/** Bound an async operation even when its dependency does not honor cancellation.
 * The caller must also pass the signal to cancellable I/O. No retries are made.
 */
export function withAbortSignal<T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason || new Error('Operation aborted'));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(operation).then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}
