import { BaseWorkflowService } from '@/lib/services/workflow/base-workflow-service';

export type CatalogIndexStart = { site_id?: string; backfill?: boolean; after_id?: string };

class CatalogIndexDispatcher extends BaseWorkflowService {
  private static singleton: CatalogIndexDispatcher;

  static instance() {
    return this.singleton ||= new CatalogIndexDispatcher();
  }

  async start(input: CatalogIndexStart) {
    const client = await this.initializeClient();
    const workflowId = input.backfill
      ? `catalog-index-backfill:${input.site_id || 'all'}` : 'catalog-index-drain';
    const handle = await client.workflow.start('catalogIndexWorkflow', {
      workflowId, taskQueue: process.env.WORKFLOW_TASK_QUEUE || 'default', args: [input],
      workflowIdConflictPolicy: 'USE_EXISTING', workflowIdReusePolicy: 'ALLOW_DUPLICATE',
    });
    return { success: true as const, workflow_id: handle.workflowId };
  }
}

export function startCatalogIndex(input: CatalogIndexStart) {
  return CatalogIndexDispatcher.instance().start(input);
}