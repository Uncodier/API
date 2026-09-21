import type { SingleTurnBackgroundTask } from './single-turn-background-task';
import type { CronInfrastructureWait } from '@/lib/services/cron-infrastructure-state';
import type { FlowGateFailureKind } from './gates/types';

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
  remediationScheduled?: boolean;
  infrastructureWait?: CronInfrastructureWait;
  infrastructureGeneration?: number;
  persistedTerminalStatus?: 'completed' | 'failed' | 'cancelled';
  gateFailureKind?: FlowGateFailureKind;
  /** True only when the contract Judge actually returned a verdict. */
  judgeAdjudicated?: boolean;
  concurrencyHalt?: boolean;
  /** True when this turn changed the Git worktree fingerprint. */
  durableProductProgress?: boolean;
}
