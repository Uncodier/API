import type { Sandbox } from '@vercel/sandbox';
import type { GitRepoKind } from './cron-commit-helpers';
import type { CronAuditContext } from '@/lib/services/cron-audit-log';
import type { SingleTurnResult } from './single-turn-types';

export interface RunSingleTurnGateInput {
  sandbox: Sandbox;
  effectiveSandboxId: string;
  plan: any;
  step: any;
  persistedStep: any;
  requirementId: string;
  instanceId: string;
  siteId: string;
  userId?: string;
  requirementType: string;
  gitRepoKind: GitRepoKind;
  validateDeployment?: boolean;
  backlogItemId: string | null;
  interactionBaselineSha?: string;
  systemPrompt: string;
  result: any;
  fullTools: any;
  audit: CronAuditContext;
  infrastructureGeneration: number;
  executionEventId: string;
  requireContractJudge?: boolean;
  sleepRequested?: number;
  backgroundTask?: SingleTurnResult['backgroundTask'];
}
