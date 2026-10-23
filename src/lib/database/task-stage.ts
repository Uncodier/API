import { z } from 'zod';

// Customer journey stages from tasks_stage_check; execution state belongs in status.
export const TASK_STAGES = ['awareness', 'consideration', 'decision', 'purchase', 'retention', 'referral'] as const;
export const DEFAULT_TASK_STAGE = TASK_STAGES[0];
export const TaskStageSchema = z.enum(TASK_STAGES);