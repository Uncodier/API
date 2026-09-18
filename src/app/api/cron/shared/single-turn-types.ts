import type { SingleTurnBackgroundTask } from './single-turn-background-task';
import type { CronInfrastructureWait } from '@/lib/services/cron-infrastructure-state';

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
  persistedTerminalStatus?: 'completed' | 'failed';
  concurrencyHalt?: boolean;
}
