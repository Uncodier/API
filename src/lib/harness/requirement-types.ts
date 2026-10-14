import type { HarnessSession } from './types';

/** Host-resolved cron identity. Never accepted from model tool arguments. */
export interface RequirementRun {
  requirementId: string;
  siteId: string;
  userId: string;
  instanceId: string;
  runId: string;
  executionGeneration: number;
  sessionId: string;
}

export interface RequirementSource {
  id: string;
  site_id: string;
  user_id: string;
  title: string;
  instructions?: string | null;
  description?: string | null;
  type?: string | null;
  status: string;
  cron?: string | null;
  updated_at?: string;
  backlog?: { items?: Array<Record<string, any>>; [key: string]: unknown } | null;
  backlog_revision?: number;
  metadata?: Record<string, any> | null;
}

export interface RequirementClaim {
  state: 'claimed';
  run: RequirementRun;
  requirement: RequirementSource;
}

export interface RequirementContext {
  requirement: RequirementSource;
  plans: Array<Record<string, any>>;
  history: Array<Record<string, any>>;
  revision: string;
}

export type RequirementCycleResult = {
  status: HarnessSession['status'] | 'not_claimed';
  continue: boolean;
};