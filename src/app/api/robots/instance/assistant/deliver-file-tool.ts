import { createCloudFileTools } from '@/lib/cloud-files/tools';
import { resolveAssistantFileEnvironment } from './cloud-context';
import type { CloudScope } from '@/lib/cloud-files/types';

/** Common, on-demand document delivery. Never writes to an executable repository. */
export function deliverFileTool(siteId: string, userId: string | undefined, instanceId: string, requirementId?: string) {
  const scope: CloudScope = { siteId, userId: userId ?? '', instanceId, requirementId };
  const descriptors = createCloudFileTools(scope, async () => {});
  const schema = (name: string) => descriptors.find(tool => tool.name === name)!.parameters as {
    properties: Record<string, unknown>;
  };
  return {
    name: 'deliver_file',
    description: 'Save and push a private document to the configured non-deploy Git repository, or list/read its versions. Available to every agent role, including workspace and workflow agents; no sandbox or coding agent needed. Load skill_lookup skill_name="file-delivery" for presentations (HTML), documents (Markdown/HTML), and sheets (CSV). UTF-8 text only, maximum 262144 bytes. Does not edit the app branch, deploy a preview, or accept binary Office files. Returns saved/download receipts and actual Git status. Do not ask for a repository.',
    parameters: {
      type: 'object',
      properties: {
        ...schema('write_cloud_file').properties,
        ...schema('list_cloud_files').properties,
        ...schema('read_cloud_file').properties,
        action: { type: 'string', enum: ['list', 'read', 'create', 'replace', 'patch'] },
      },
      required: ['action'],
      additionalProperties: false,
    },
    execute: async (raw: Record<string, unknown>) => {
      if (!userId) return { ok: false, error: { code: 'forbidden', effectStarted: false } };
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, error: { code: 'invalid_input', effectStarted: false } };
      }
      const { action, ...args } = raw;
      const name = action === 'list' ? 'list_cloud_files' : action === 'read' ? 'read_cloud_file'
        : ['create', 'replace', 'patch'].includes(action as string) ? 'write_cloud_file' : undefined;
      if (!name) return { ok: false, error: { code: 'invalid_input', effectStarted: false } };
      // Persisted ownership, never a model-selected requirement or repository.
      const binding = await resolveAssistantFileEnvironment(scope);
      const assertBinding = async () => {
        const current = await resolveAssistantFileEnvironment(scope);
        if (current.requirementId !== binding.requirementId || current.environment !== binding.environment) {
          throw new Error('Document binding changed; refresh before delivery');
        }
      };
      // Explicit document capability permits version-fenced collaboration, not
      // runner control, filesystem writes, or deployment. Canonical screen,
      // actor, instance, quota and database ownership checks still apply.
      const tools = createCloudFileTools({ ...scope, requirementId: binding.requirementId }, assertBinding,
        { allowRequirementWrite: true });
      return tools.find(tool => tool.name === name)!.execute(name === 'write_cloud_file' ? raw : args);
    },
  };
}