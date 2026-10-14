/** Bound even integrations that forget to observe AbortSignal. Late settlement is
 * consumed, never retried. The caller must treat interrupted writes as ambiguous. */
export async function withinDeadline<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const interruption = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error('Operation deadline exceeded or execution cancelled'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(operation), interruption]); }
  finally { signal.removeEventListener('abort', abort); }
}