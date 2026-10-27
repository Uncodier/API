import type { AssistantContext } from './types';
import type { AssistantExecutionBoundary } from '@/lib/services/robot-instance/assistant-execution-boundary';
import type { RoutedTool } from '@/app/api/agents/tools/router/assistantProtocol';

/** Process-local authority. JSON, model arguments and workflow inputs cannot forge it. */
export interface RequirementAssistantHost {
  assertActive(): Promise<void>;
  boundary: AssistantExecutionBoundary;
  tools: any[];
  refreshContext(): Promise<string>;
}
const hosts = new WeakMap<AssistantContext, RequirementAssistantHost>();

export function attachRequirementAssistantHost(context: AssistantContext, host: RequirementAssistantHost): void {
  hosts.set(context, host);
}

export function readRequirementAssistantHost(context: AssistantContext): RequirementAssistantHost | undefined {
  return hosts.get(context);
}

/** Apply before router closures capture tools. Do not let a runner create a competing owner. */
export function guardRequirementAssistantTools(host: RequirementAssistantHost, tools: RoutedTool[]): RoutedTool[] {
  return tools.map(tool => ({ ...tool, execute: async (args: any) => {
    await host.assertActive();
    if (['activate_coding_agents', 'update_repo'].includes(tool.name) ||
      (tool.name === 'instance_plan' && args?.action !== 'list') ||
      (tool.name === 'requirement_backlog' && !['get', 'list'].includes(args?.action)) ||
      (tool.name === 'requirement_status' && (args?.action ?? 'list') !== 'list') ||
      (tool.name === 'requirements' && !['get', 'list', 'read'].includes(args?.action))) {
      return { success: false, executed: false, error: 'Use the owned requirement_plan and requirement_progress tools. This runner cannot create another executor or change its execution authority.' };
    }
    return tool.execute(args);
  } }));
}