import { isReportOnlyRequirement } from '../report-delivery-policy';

const input = { flow: 'makinari', instructions: 'Sin código/repositorio/carpetas.',
  items: [{ id: 'report', kind: 'doc' as const }],
  steps: [{ backlog_item_id: 'report', instructions: 'Entregar informe en step_output.' }],
};
describe('whole-requirement report delivery policy', () => {
  it('requires explicit nonrepository delivery and every backlog item to qualify', () => {
    expect(isReportOnlyRequirement(input)).toBe(true);
    expect(isReportOnlyRequirement({ ...input, items: [] })).toBe(false);
    expect(isReportOnlyRequirement({ ...input, instructions: '' })).toBe(false);
    expect(isReportOnlyRequirement({ ...input, flow: 'app' })).toBe(false);
    expect(isReportOnlyRequirement({ ...input, flow: 'doc' })).toBe(false);
    expect(isReportOnlyRequirement({ ...input, items: [...input.items, { id: 'code', kind: 'api' }] })).toBe(false);
    expect(isReportOnlyRequirement({ ...input, items: [{ ...input.items[0], touches: ['report.md'] }] })).toBe(false);
  });
  it('does not borrow another item step output contract or ignore executable step requirements', () => {
    expect(isReportOnlyRequirement({ ...input, items: [...input.items, { id: 'other', kind: 'doc' }] })).toBe(false);
    expect(isReportOnlyRequirement({ ...input, steps: [{ ...input.steps[0], backlog_item_id: 'other' }] })).toBe(false);
    expect(isReportOnlyRequirement({ ...input, steps: [{ ...input.steps[0], role: 'backend' }] })).toBe(false);
    expect(isReportOnlyRequirement({ ...input, steps: [{ ...input.steps[0], test_command: 'npm test' }] })).toBe(false);
    expect(isReportOnlyRequirement({ ...input, steps: [{ ...input.steps[0], validation_targets: ['/api/check'] }] })).toBe(false);
  });
});