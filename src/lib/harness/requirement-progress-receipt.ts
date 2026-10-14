import { requirementItemId, requirementRecordId, safeRequirementText } from './requirement-context';
import type { Json } from './types';

const statuses = ['pending', 'in_progress', 'active', 'completed', 'done', 'failed', 'blocked', 'paused', 'cancelled'];
const status = (value: unknown): string | null => typeof value === 'string' && statuses.includes(value) ? value : null;
const count = (value: unknown): number | null => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
const safeItemId = (value: unknown): value is string => requirementItemId(value) && safeRequirementText(value, 200) === value;

/** Only atomic provider facts; never infer completion from requested arguments or
 * echo arbitrary RPC metadata. Older deployments may return only a basic receipt. */
export function progressReceipt(receipt: Record<string, unknown>): Record<string, Json> {
  const output: Record<string, Json> = {
    state: receipt.state as string,
    backlog_revision: count(receipt.backlog_revision),
    note: 'Progress recorded, not independently verified acceptance. Plan status and task completion are separate actions.',
  };
  if (requirementRecordId(receipt.plan_id)) output.planId = receipt.plan_id;
  if (typeof receipt.status_changed !== 'boolean') {
    output.currentStateAvailable = false;
    output.guidance = 'Current statuses were not returned. Read requirement_context for fresh state; do not infer that a step update closed its plan.';
    return output;
  }
  output.currentStateAvailable = true;
  output.statusChanged = receipt.status_changed;
  output.messageRecorded = receipt.message_recorded === true;
  if (requirementRecordId(receipt.plan_id)) output.plan = {
    id: receipt.plan_id, status: status(receipt.plan_status),
    stepsTotal: count(receipt.plan_steps_total), stepsCompleted: count(receipt.plan_steps_completed),
  };
  if (safeItemId(receipt.step_id)) output.step = { id: receipt.step_id, status: status(receipt.step_status) };
  if (safeItemId(receipt.item_id)) output.item = { id: receipt.item_id, status: status(receipt.item_status) };
  output.backlog = { itemsTotal: count(receipt.backlog_items_total), itemsCompleted: count(receipt.backlog_items_completed) };
  output.guidance = receipt.status_changed
    ? 'Only the reported targets changed. Choose further work, record plan completion, or finish_task when appropriate.'
    : 'The requested statuses already match. Repeating them will not close a different target. Choose further work or finish_task when appropriate.';
  if (!receipt.plan_id && !receipt.step_id && !receipt.item_id && receipt.message_recorded === true) {
    output.guidance = 'The progress message was recorded. No status target was changed. Choose further work or finish_task when appropriate.';
  }
  const total = count(receipt.plan_steps_total), complete = count(receipt.plan_steps_completed);
  if (requirementRecordId(receipt.plan_id) && status(receipt.plan_status) !== null &&
      !['completed', 'paused', 'cancelled'].includes(String(receipt.plan_status)) && total !== null && total > 0 && complete === total) {
    output.guidance = 'All steps are recorded completed, but the plan is not. If the plan is finished, explicitly update target=plan without stepId or itemId. This is an available action, not a requirement to stop working.';
    output.availableAction = { tool: 'requirement_progress', arguments: { target: 'plan', planId: receipt.plan_id, status: 'completed' } };
  } else if (receipt.plan_status === 'completed') {
    output.guidance = 'The plan is recorded completed. Continue any remaining requested work, or call finish_task with an honest result. No further progress write is required merely to acknowledge this receipt.';
  }
  return output;
}