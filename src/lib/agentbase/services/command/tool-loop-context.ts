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
  arguments?: unknown;
  error?: unknown;
  result?: unknown;
};

/** Remove redundant catalog columns, never candidates or search provenance. */
function compactToolResult(fn: ToolFn): unknown {
  const result = fn.result;
  if (fn.name !== 'catalog_commerce' || !result || typeof result !== 'object') return result;
  const catalog = result as Record<string, unknown>;
  if (!Array.isArray(catalog.items)) return result;
  const redundantFields = new Set(['site_id', 'image_url', 'is_marketplace_listed', 'is_pos_available']);
  return {
    ...catalog,
    items: catalog.items.map(item => {
      if (!item || typeof item !== 'object') return item;
      return Object.fromEntries(Object.entries(item).filter(([key]) => !redundantFields.has(key)));
    }),
  };
}

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
      const lines = [error ? `- ${name}: ${status} Error: ${error}` : `- ${name}: ${status}`];
      if (fn.arguments !== undefined) {
        lines.push(`Arguments: ${typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments)}`);
      }
      if (fn.result !== undefined) {
        lines.push(`Result: ${JSON.stringify(compactToolResult(fn))}`);
      }
      return lines.join('\n');
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
