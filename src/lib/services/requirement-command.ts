import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';

/** Captured by the assistant host, never read from model arguments or prose. */
export type RequirementCommandSource = {
  siteId: string;
  userId: string;
  instanceId: string;
  actionId: string;
};

const sourceSchema = z.object({
  siteId: z.string().uuid(), userId: z.string().uuid(),
  instanceId: z.string().uuid(), actionId: z.string().uuid(),
}).strict();

const patchSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  description: z.string().max(24000).optional(),
  instructions: z.string().min(1).max(48000).optional(),
  priority: z.enum(['high', 'medium', 'low']).optional(),
  status: z.enum(['backlog', 'in-progress']).optional(),
  completion_status: z.literal('pending').optional(),
  type: z.string().min(1).max(100).optional(),
  budget: z.number().finite().nonnegative().optional(),
  cron: z.string().max(200).optional(),
  cycle: z.string().max(200).optional(),
}).strict().refine(patch => Object.values(patch).some(value => value !== undefined), 'Include the requested changes.');

/** Persist changes and authorization together; never start, resume or replace a runner. */
export async function submitRequirementCommand(
  requirementId: string,
  patch: unknown,
  source: RequirementCommandSource,
) {
  const identity = sourceSchema.parse(source);
  const changes = patchSchema.parse(patch);
  z.string().uuid().parse(requirementId);
  const { data, error } = await supabaseAdmin.rpc('submit_requirement_command', {
    p_requirement_id: requirementId, p_site_id: identity.siteId,
    p_user_id: identity.userId, p_instance_id: identity.instanceId,
    p_action_id: identity.actionId, p_patch: changes,
  });
  if (error) throw new Error('Requirement command could not be authorized or queued. Check access and the command migration.');
  if (!data || !['queued', 'duplicate'].includes(data.state) ||
      data.authorization_action_id !== identity.actionId ||
      data.requirement?.id !== requirementId || data.requirement?.site_id !== identity.siteId) {
    throw new Error('Requirement command returned an unverifiable receipt. Execution was not started.');
  }
  return {
    success: true,
    requirement: data.requirement,
    command: {
      state: data.state as 'queued' | 'duplicate',
      authorization_action_id: identity.actionId,
      runner_instance_id: data.runner_instance_id ?? null,
      execution_started: false,
      message: 'Changes are queued for the existing requirement runner after this user action finishes and its current cycle releases ownership. No second executor was started.',
    },
  };
}