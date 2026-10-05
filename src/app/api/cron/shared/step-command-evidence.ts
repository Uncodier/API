import type { CommandEvidenceSignal } from '@/lib/services/requirement-evidence-types';
import { commandEvidenceIsCurrent } from '@/lib/services/requirement-command-evidence';
import { sanitizeRuntimeLog } from './runtime-log-context';

function record(value: unknown): Record<string, any> {
  if (value && typeof value === 'object') return value as Record<string, any>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

/** Only host-bound completed validation receipts can become command evidence. */
export function extractCommandEvidenceFromResult(params: {
  result: any;
  requirementId: string;
  itemId: string | null;
  stepId: string;
  validatedFingerprint?: string;
}): CommandEvidenceSignal[] {
  if (!params.itemId || !params.validatedFingerprint) return [];
  let commands: CommandEvidenceSignal[] = [];
  for (const step of params.result?.steps || []) {
    const results = new Map<string, any>(
      (step.toolResults || []).map((result: any) => [result.toolCallId, result]),
    );
    for (const call of step.toolCalls || []) {
      // A later repository write invalidates receipts from earlier in the turn.
      if (['sandbox_write_file', 'sandbox_edit_file', 'sandbox_delete_file'].includes(call.toolName)) {
        commands = [];
      }
      if (call.toolName !== 'sandbox_run_validation') continue;
      const result = results.get(call.id || call.toolCallId);
      if (!result || result.isError === true) continue;
      const payload = record(result.result ?? result.output ?? result.content);
      // Product failures carry actual exit receipts; transport errors do not.
      if (payload.error && payload.code !== 'VALIDATION_PRODUCT_FAILURE') continue;
      const receipt = record(payload.receipt);
      if (receipt.kind !== 'command_execution' ||
        receipt.requirement_id !== params.requirementId ||
        receipt.item_id !== params.itemId || receipt.step_id !== params.stepId ||
        receipt.workspace_fingerprint !== params.validatedFingerprint ||
        !Array.isArray(receipt.commands)) continue;
      for (const signal of receipt.commands) {
        if (!signal || !commandEvidenceIsCurrent(signal, params.stepId, params.validatedFingerprint)) continue;
        if (payload.error && signal.exit_code === 0) continue;
        commands.push({
          ...signal,
          output_tail: sanitizeRuntimeLog(signal.output_tail).slice(-6000),
        });
      }
    }
  }
  return commands;
}