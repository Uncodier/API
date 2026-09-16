import type { SingleTurnBackgroundTask } from './single-turn-background-task';

export interface SingleTurnResult {
  ok: boolean;
  isDone: boolean;
  transient?: boolean;
  error?: string;
  effectiveSandboxId: string;
  sleepRequested?: number;
  backgroundTask?: SingleTurnBackgroundTask;
  gatePassed?: boolean;
  gateErrorExcerpt?: string;
}
