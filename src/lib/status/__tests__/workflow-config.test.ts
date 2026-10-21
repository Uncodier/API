import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('status deploy probes', () => {
  it('does not turn on billable inference implicitly and includes explicit public-site context', () => {
    const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/system-status.yml'), 'utf8');
    expect(workflow).toContain("STATUS_AI_PROBE_ENABLED: ${{ vars.STATUS_AI_PROBE_ENABLED || 'false' }}");
    expect(workflow).not.toContain("STATUS_AI_PROBE_ENABLED: 'true'");
    expect(workflow).toContain('STATUS_PROBE_SITE_ID: ${{ vars.STATUS_PROBE_SITE_ID }}');
  });
});