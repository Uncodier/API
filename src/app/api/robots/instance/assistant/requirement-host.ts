import type { AssistantContext } from './types';
import type { AssistantExecutionBoundary } from '@/lib/services/robot-instance/assistant-execution-boundary';
import type { RoutedTool } from '@/app/api/agents/tools/router/assistantProtocol';

/** Process-local authority. JSON, model arguments and workflow inputs cannot forge it. */
export interface RequirementAssistantHost {
  assertActive(): Promise<void>;
  boundary: AssistantExecutionBoundary;
  tools: any[];
  environment?: 'cloud' | 'workspace';
  refreshContext(): Promise<string>;
}
const hosts = new WeakMap<AssistantContext, RequirementAssistantHost>();
const stepResults = new WeakMap<AssistantContext, () => unknown>();

/** In-process only: a host result must stop later tools in the same model batch. */
export function attachAssistantStepResult(context: AssistantContext, getResult: () => unknown): void {
  stepResults.set(context, getResult);
}

export function readAssistantStepResult(context: AssistantContext): unknown {
  return stepResults.get(context)?.();
}

export function attachRequirementAssistantHost(context: AssistantContext, host: RequirementAssistantHost): void {
  hosts.set(context, host);
}

export function readRequirementAssistantHost(context: AssistantContext): RequirementAssistantHost | undefined {
  return hosts.get(context);
}

/** Apply before router closures capture tools. Do not let a runner create a competing owner. */
export function filterRequirementEnvironmentTools(environment: RequirementAssistantHost['environment'], tools: RoutedTool[]): RoutedTool[] {
  const workspaceNames = new Set(['read_files', 'list_files', 'search', 'apply_patch', 'exec', 'process_status', 'process_stop',
    'source_archive', 'deployment_create', 'deployment_environment_sync', 'deployment_status', 'tracking_install', 'platform_key_provision']);
  // Filter before the router captures the catalog: the wrong resource family is
  // not searchable or callable, rather than relying on a prompt to avoid it.
  return tools.filter(tool => environment === 'cloud'
    ? !workspaceNames.has(tool.name) && !tool.name.startsWith('sandbox_') && !['activate_coding_agents', 'update_repo'].includes(tool.name)
    : environment === 'workspace' ? !['read_cloud_file', 'list_cloud_files', 'write_cloud_file'].includes(tool.name) : true);
}

export function guardRequirementAssistantTools(host: RequirementAssistantHost, tools: RoutedTool[]): RoutedTool[] {
  const selected = filterRequirementEnvironmentTools(host.environment, tools);
  return selected.map(tool => ({ ...tool, execute: async (args: any) => {
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