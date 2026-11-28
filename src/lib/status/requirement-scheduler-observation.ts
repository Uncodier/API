type RouteStage = 'scheduled' | 'claim' | 'dispatch' | 'finish' | 'cloud_git';
const dbStages = ['economic_pause', 'pending_commands', 'reservation'] as const;
type Stage = RouteStage | typeof dbStages[number];
type Stop = 'empty' | 'capacity_full' | 'limit' | 'deadline' | 'error';
export type ClaimFailure = 'rpc_unavailable' | 'timeout' | 'contention' | 'request_failed';

// Out-of-band, request-local evidence. No body, client header or error message
// is accepted as telemetry input. Do not add fields to the cron response body.
const receipts = new WeakMap<Response, { status: 'up' | 'degraded' | 'down'; message: string }>();
export const schedulerReceipt = (response: Response) => receipts.get(response);

export function schedulerObservation() {
  const stages = new Map<Stage, number>();
  let measuredClaims = 0, claimed = 0, dispatchFailures = 0;
  let failure: ClaimFailure | undefined;
  let failedStage: RouteStage | undefined;
  function add(stage: Stage, ms: number) {
    stages.set(stage, Math.min(60_000, (stages.get(stage) ?? 0) + ms));
  }
  return {
    async measure<T>(stage: RouteStage, work: () => Promise<T>) {
      const started = performance.now();
      try { return await work(); }
      catch (error) {
        if (stage === 'dispatch') dispatchFailures++;
        // Cloud Git is independent and its fallback is not a claim failure.
        else if (stage !== 'cloud_git') failedStage = stage;
        throw error;
      } finally { add(stage, performance.now() - started); }
    },
    claimStages(raw: unknown) {
      if (!raw || typeof raw !== 'object') return;
      const values = raw as Record<string, unknown>;
      if (!dbStages.every(key => {
        const ms = values[key];
        return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0;
      })) return;
      for (const key of dbStages) add(key, values[key] as number);
      measuredClaims++;
    },
    claimFailure(category: ClaimFailure) { failure = category; },
    claimed() { claimed++; },
    headers: () => ({ 'Server-Timing': Array.from(stages, ([key, ms]) => `${key};dur=${ms.toFixed(1)}`).join(', ') }),
    complete(response: Response, stop: Stop) {
      const status = response.status >= 500 ? 'down' : dispatchFailures ? 'degraded' : 'up';
      receipts.set(response, { status, message: JSON.stringify({ v: 1, stop, claimed, dispatch_failed: dispatchFailures,
        measured_claims: measuredClaims, failed_stage: failedStage, claim_failure: failure,
        ms: Object.fromEntries(Array.from(stages, ([key, ms]) => [key, Math.round(ms)])),
      }) });
      return response;
    },
  };
}
