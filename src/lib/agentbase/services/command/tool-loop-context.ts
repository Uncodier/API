/**
 * Compact replaceable block for tool-completion turns 2+.
 * Original user context is kept once; later turns do not append another copy of the instruction.
 */

const TURN_MARKERS = ['=== TOOL COMPLETION TURN ===', '=== TOOL CORRECTION TURN ==='];
const MAX_ERROR_CHARS = 500;

type ToolFn = {
  id?: string;
  name?: string;
  status?: string;
  error?: unknown;
  result?: unknown;
};

export function stripToolTurnBlocks(context: string): string {
  if (!context) return '';
  let cutAt = -1;
  for (const marker of TURN_MARKERS) {
    const idx = context.indexOf(marker);
    if (idx >= 0 && (cutAt < 0 || idx < cutAt)) {
      cutAt = idx;
    }
  }
  return (cutAt >= 0 ? context.slice(0, cutAt) : context).trimEnd();
}

function toolErrorText(fn: ToolFn): string {
  const fromError = typeof fn.error === 'string' ? fn.error : '';
  const result = fn.result as { error?: unknown } | undefined;
  const fromResult = typeof result?.error === 'string' ? result.error : '';
  const text = fromError || fromResult;
  if (!text) return '';
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}…` : text;
}

export function summarizeFunctions(functions: ToolFn[] = []): string {
  if (!functions.length) return 'None';
  return functions
    .map((fn) => {
      const name = String(fn?.name || fn?.id || 'unknown');
      const status = String(fn?.status || 'unknown');
      const error = toolErrorText(fn);
      return error ? `- ${name}: ${status} Error: ${error}` : `- ${name}: ${status}`;
    })
    .join('\n');
}

export function lastFailedToolError(functions: ToolFn[] = []): string {
  for (let i = functions.length - 1; i >= 0; i--) {
    const fn = functions[i];
    if (String(fn?.status || '') !== 'failed') continue;
    const error = toolErrorText(fn);
    if (error) return error;
  }
  return '';
}

export function buildToolTurnContext(params: {
  originalContext: string;
  instruction: string;
  functions?: ToolFn[];
}): string {
  const original = stripToolTurnBlocks(params.originalContext || '');
  const summary = summarizeFunctions(params.functions || []);
  const lastError = lastFailedToolError(params.functions || []);
  const lastErrorBlock = lastError ? `\nLAST TOOL ERROR:\n${lastError}` : '';
  return `${original}\n${params.instruction}\nTOOL RESULTS SUMMARY:\n${summary}${lastErrorBlock}`.trim();
}
