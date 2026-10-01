import { supabaseAdmin } from '@/lib/database/supabase-client';
import { buildInitialNodeResult, buildNodeResult, type NodeResult, type NodeToolOutput } from './node-result-collector';

/** Only an actual terminal assistant message can finish a bounded node chunk. */
export function finalNodeAssistantText(result: { messages?: any[] }): string {
  const last = result.messages?.[result.messages.length - 1];
  if (last?.role !== 'assistant' || last.tool_calls?.length) return '';
  if (typeof last.content === 'string') return last.content.trim();
  if (Array.isArray(last.content)) {
    return last.content.filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
      .map((part: any) => part.text).join('\n').trim();
  }
  return '';
}

function storedOutputs(result: any): NodeToolOutput[] {
  if (typeof result === 'string') {
    try { result = JSON.parse(result); } catch { return []; }
  }
  return Array.isArray(result?.outputs) ? result.outputs.filter((output: any) =>
    output && typeof output.tool_name === 'string' && typeof output.type === 'string' &&
    output.data && typeof output.data === 'object' && Object.keys(output.data).length > 0) : [];
}

function mergeOutputs(previous: NodeToolOutput[], current: NodeToolOutput[]): NodeToolOutput[] {
  const keys = new Set<string>();
  return [...previous, ...current].filter(output => {
    const key = JSON.stringify([output.tool_name, output.type, output.data.url || output.data]);
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
}

/** Stream and settle the same response node without losing earlier generated assets. */
export function createNodeChunkWriter(nodeId: string, promptNode: any, previousResult?: any) {
  const previousOutputs = storedOutputs(previousResult);
  const initialOutputs = previousOutputs.length > 0
    ? previousOutputs : buildInitialNodeResult(promptNode).outputs;
  let lastUpdate = 0;
  let accumulatedText = '';
  const persist = async (payload: Record<string, unknown>) => {
    const { data, error } = await supabaseAdmin.from('instance_nodes')
      .update({ ...payload, updated_at: new Date().toISOString() })
      .eq('id', nodeId).eq('parent_node_id', promptNode.id).eq('type', 'response')
      .eq('instance_id', promptNode.instance_id).eq('site_id', promptNode.site_id)
      .not('status', 'in', '(stopped,cancelled)')
      .select('id').single();
    if (error || data?.id !== nodeId) throw new Error('Unable to persist the scoped response node');
    // The workflow owns the user log, including cancellation and fan-out completion.
  };
  return {
    async onChunk(text: string, final = false) {
      accumulatedText = text;
      if (!final && Date.now() - lastUpdate < 500) return;
      const result: NodeResult = { text, status: 'streaming' };
      if (initialOutputs?.length) result.outputs = initialOutputs;
      await persist({ result, status: 'running' });
      lastUpdate = Date.now();
    },
    async finish(execution: { text?: string; steps?: any[]; messages?: any[] }) {
      const finalText = finalNodeAssistantText(execution);
      const isDone = finalText.length > 0;
      const result = buildNodeResult(finalText || execution.text || accumulatedText,
        isDone ? 'done' : 'streaming', execution.steps);
      if (!isDone) result.status = 'running';
      const outputs = mergeOutputs(previousOutputs, result.outputs || []);
      if (outputs.length > 0) result.outputs = outputs;
      await persist({ result, status: isDone ? 'completed' : 'running' });
      return isDone;
    },
    async fail(errorMessage: string) {
      await persist({ status: 'failed', result: { error: errorMessage } });
    },
  };
}