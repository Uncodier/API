import { operationFingerprint } from '@/lib/harness/security';
import { normalizeToolOperationResult } from '@/lib/services/tool-operation-result';
import type { ToolResult } from '@/lib/harness/types';

/** A local command's known nonzero exit is failure, not an unknown dispatch outcome.
 * It does not claim the command made no writes; only its completed result is known.
 */
export function isCompletedLocalCommand(name: string, value: any): boolean {
  return name === 'exec' && value?.ok === false && value?.error?.code === 'COMMAND_EXIT_NONZERO' &&
    value.error.ambiguous !== true && Number.isInteger(value.output?.exitCode) && value.output.exitCode !== 0 &&
    value.output.truncated === false && typeof value.output.stdout === 'string' &&
    typeof value.output.stderr === 'string' && typeof value.output.processId === 'string' && value.output.processId.length > 0;
}

/** Router transport syntax and reasoning metadata are not part of the effect. */
export function requirementOperationFingerprint(name: string, args: Record<string, unknown>): string {
  const { thought_process: _reasoning, ...effect } = args;
  if (name === 'tools' && effect.action === 'call' && typeof effect.name === 'string') {
    let inner = effect.args;
    try { if (typeof inner === 'string') inner = JSON.parse(inner); } catch { /* Invalid calls cannot dispatch. */ }
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      const { thought_process: _innerReasoning, ...parameters } = inner as Record<string, unknown>;
      return operationFingerprint(effect.name, parameters);
    }
  }
  return operationFingerprint(name, effect);
}

/** Use the same envelope semantics as assistant; transport success is not effect success. */
export function requirementOperationResult(value: any): ToolResult {
  const normalized = normalizeToolOperationResult(value, {
    transportError: typeof value?.status === 'number' && value.status >= 400,
  });
  if (normalized.outcome === 'passed') return typeof value?.ok === 'boolean' ? value : { ok: true, output: value };
  let payload = normalized.payload as any;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch { /* Unstructured failures carry no pre-effect proof. */ }
  }
  // Only the failing envelope may prove no effect started, not an outer wrapper.
  const beforeEffect = payload?.executed === false || payload?.error?.effectStarted === false;
  return { ok: false, output: value, error: {
    code: payload?.error?.code || normalized.error?.code || (normalized.outcome === 'unknown' ? 'OPERATION_OUTCOME_UNKNOWN' : 'TOOL_ERROR'),
    message: normalized.error?.message || 'Tool returned no confirmed operational outcome.',
    ...(beforeEffect ? { effectStarted: false } : {}),
    ...(payload?.error?.ambiguous === true ? { ambiguous: true } : {}),
  } };
}