/** A wall-clock bound even if a transport fails to settle after AbortSignal. */
export function runtimeProbeDeadline(timeoutMs: number, parent?: AbortSignal) {
  const controller = new AbortController();
  const end = Date.now() + timeoutMs;
  const onParentAbort = () => controller.abort(parent?.reason ?? new Error('Runtime probe cancelled'));
  const timer = setTimeout(() => controller.abort(new Error(`Runtime probe deadline exceeded (${timeoutMs}ms)`)), timeoutMs);
  if (parent?.aborted) onParentAbort();
  else parent?.addEventListener('abort', onParentAbort, { once: true });
  return {
    signal: controller.signal,
    remainingMs: () => Math.max(1, end - Date.now()),
    async run<T>(operation: () => Promise<T>): Promise<T> {
      controller.signal.throwIfAborted();
      return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', onAbort, { once: true });
        // Observe late settlement without allowing subsequent I/O after the bound.
        Promise.resolve().then(() => {
          controller.signal.throwIfAborted();
          return operation();
        }).then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', onAbort));
      });
    },
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onParentAbort);
    },
  };
}