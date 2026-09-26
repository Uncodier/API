jest.mock('@/lib/services/requirement-backlog', () => ({
  isBacklogComplete: () => false,
  hasOutstandingWork: () => true,
}));

import { buildCoordinatorPromptForFlow } from '../../requirements-apps/prompt';
import { buildMaintenancePromptForFlow } from '../../maintenance/prompt';

const input = {
  reqId: 'req', title: 'App', type: 'app', instanceId: 'instance', site_id: 'site',
  workDir: '/vercel/sandbox', branchName: 'feature/app', isNewBranch: false,
  instructions: null, previousWorkContext: '',
};

describe('backlog read instructions', () => {
  it('does not confuse the default filtered list with an empty canonical backlog', () => {
    const prompt = buildCoordinatorPromptForFlow(input);
    expect(prompt).toContain('summary.total_items is 0');
    expect(prompt).toContain('pagination.next_offset');
    expect(prompt).toContain('summary.active_item_ids');
    expect(prompt).toContain("action='get'");
    expect(prompt).toContain("list_status='all'");
  });

  it('uses an explicit completed filter and item details for maintenance audits', () => {
    const prompt = buildMaintenancePromptForFlow(input);
    expect(prompt).toContain("list_status='done'");
    expect(prompt).toContain('pagination.next_offset');
    expect(prompt).toContain("action='get'");
    expect(prompt).toContain('full acceptance, constraints and evidence');
  });
});