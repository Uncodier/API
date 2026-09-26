type AssistantRun = {
  runId: string;
  readonly status: Promise<string>;
  readonly returnValue: Promise<unknown>;
};

type StreamOptions = {
  signal?: AbortSignal;
  pollMs?: number;
  timeoutMs?: number;
};

/** The workflow persists output in logs, not getWritable(). An empty default
 * stream is not an acknowledgement, completion, or error channel. Poll status
 * only while connected; read returnValue only once the run is terminal. */
export function assistantResponseStream(
  run: AssistantRun,
  instanceId: string,
  userLogId: string,
  options: StreamOptions = {},
): Response {
  const encoder = new TextEncoder();
  let stop = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let delay: ReturnType<typeof setTimeout> | undefined;
      let wake: (() => void) | undefined;
      const finish = (close = true) => {
        if (closed) return;
        closed = true;
        clearTimeout(deadline);
        clearTimeout(delay);
        wake?.();
        options.signal?.removeEventListener('abort', onAbort);
        if (close) controller.close();
      };
      const event = (type: string, fields: Record<string, unknown>) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify({
          type, run_id: run.runId, instance_id: instanceId, ...fields,
        })}\n\n`));
      };
      const fail = (code: string, message: string) => {
        event('error', { success: false, error: { code, message } });
        finish();
      };
      const onAbort = () => finish();
      stop = () => finish(false);
      if (options.signal?.aborted) { finish(); return; }
      options.signal?.addEventListener('abort', onAbort, { once: true });
      event('accepted', { user_log_id: userLogId, success: true });
      deadline = setTimeout(() => fail('ASSISTANT_RESPONSE_TIMEOUT',
        'The response connection timed out. The workflow may still be running; check this session before retrying.'), options.timeoutMs ?? 750_000);
      void (async () => {
        try {
          let lastHeartbeat = Date.now();
          while (!closed) {
            const status = await run.status;
            if (closed) return;
            if (status === 'failed' || status === 'cancelled') {
              fail(status === 'cancelled' ? 'ASSISTANT_WORKFLOW_CANCELLED' : 'ASSISTANT_WORKFLOW_FAILED',
                status === 'cancelled' ? 'Assistant execution was cancelled.' : 'Assistant execution failed. Check this session for details; its error log may be unavailable.');
              return;
            }
            if (status === 'completed') {
              const result = await run.returnValue;
              if (closed) return;
              if (result && typeof result === 'object' && (result as { success?: boolean }).success === false) {
                if ((result as { execution_status?: string }).execution_status === 'continuing') {
                  fail('ASSISTANT_WORKFLOW_CONTINUING', 'Assistant execution is continuing in the background. Check this session before sending again.');
                } else {
                  fail('ASSISTANT_WORKFLOW_INCOMPLETE', 'Assistant execution paused before completion. Its progress is saved in this session.');
                }
              } else {
                event('completed', { success: true, data: result });
                finish();
              }
              return;
            }
            if (Date.now() - lastHeartbeat >= 15_000) {
              controller.enqueue(encoder.encode(': keep-alive\n\n'));
              lastHeartbeat = Date.now();
            }
            await new Promise<void>(resolve => {
              wake = resolve;
              delay = setTimeout(resolve, options.pollMs ?? 1500);
            });
          }
        } catch {
          // Never expose provider payloads, prompts, stacks or credentials.
          if (!closed) fail('ASSISTANT_STATUS_UNAVAILABLE',
            'Unable to confirm the assistant result. The workflow may still be running; check this session before retrying.');
        }
      })();
    },
    cancel() { stop(); },
  });
  return new Response(body, { headers: {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'X-Workflow-Run-Id': run.runId,
    'X-Assistant-Stream-Version': '1',
  } });
}