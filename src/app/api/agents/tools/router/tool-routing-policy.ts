import type { RoutedTool } from './assistantProtocol';

/** Host-owned execution schema when the published provider schema omits supported wire forms. */
export const NATIVE_ARGUMENT_SCHEMA = Symbol.for('makinari.native-argument-schema');

export function injectThoughtProcess(tool: RoutedTool): RoutedTool {
  if (!tool.parameters?.properties || Object.hasOwn(tool.parameters.properties, 'thought_process')) return tool;
  return {
    ...tool,
    parameters: {
      ...tool.parameters,
      properties: {
        ...tool.parameters.properties,
        thought_process: {
          type: 'string',
          description: 'Optional: a brief public purpose for the call. Omit if unnecessary; do not include private reasoning.',
        },
      },
    },
  };
}

/**
 * Canonical always-on set (minimal).
 *
 * Shared by orchestrator and executors so behaviour is consistent.
 */
export const DEFAULT_ALWAYS_ON_TOOL_NAMES: ReadonlySet<string> = new Set([
  // Host-bound requirement capabilities share the same routing/permission guards.
  'read_files', 'list_files', 'search', 'apply_patch', 'exec', 'process_status', 'process_stop',
  'read_cloud_file', 'list_cloud_files', 'write_cloud_file',
  'tracking_install', 'source_archive', 'deployment_trigger', 'deployment_status',
  'deployment_create', 'deployment_environment_sync', 'platform_key_provision',
  'capability_manifest', 'requirement_context', 'requirement_progress', 'requirement_plan',
  'finish_task', 'read_session_history', 'read_result_artifact',
  // sandbox surface — every agent uses these every turn
  'webSearch',
  'skill_lookup',
  'external_skill_lookup',
  'sandbox_run_command',
  'sandbox_read_file',
  'sandbox_list_files',
  'sandbox_write_file',
  'sandbox_push_checkpoint',
  'sandbox_restore_checkpoint',
  'sandbox_read_logs',
  // QA sandbox tools (names from getQaSandboxTools — we keep any whose name starts with sandbox_ or qa_)
  // They are added dynamically below via the isAlwaysOn() helper if needed.

  // plan + requirement surface — the contract between agents and the workflow
  'instance_plan',
  'requirement_status',
  'requirement_backlog',
  'requirements',
  'plan_result',
  'harness_inspect',
  'harness_events',
  'harness_reference',
  'harness_source',
  'harness_decide',
  
  // direct ui feedback surface
  'show_artifact',
]);

/**
 * More permissive check used by the partition helper: treats every tool whose
 * name starts with `sandbox_` or `qa_` as always-on, in addition to the
 * explicit set above. This future-proofs QA/sandbox tool additions without
 * having to update the constant each time.
 */
export function isAlwaysOnToolName(name: string): boolean {
  if (DEFAULT_ALWAYS_ON_TOOL_NAMES.has(name)) return true;
  if (name === 'webSearch') return true;
  if (name.startsWith('sandbox_')) return true;
  if (name.startsWith('qa_')) return true;
  return false;
}

