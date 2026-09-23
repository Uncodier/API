import { parseWorkflowExpectedOutputContract } from '../result-shape';

describe('workflow expected output contracts', () => {
  test('proposes a canonical contract for recognizable legacy collections', () => {
    const parsed = parseWorkflowExpectedOutputContract(
      '{[{url:"url", summary:"opportunity", value:"bid range"}], total-opportuinies:x}',
      { title: 'CRM opportunities' },
    );

    expect(parsed).toMatchObject({
      structured: true,
      repaired: true,
      suggestion:
        '{ opportunities: [{ url: string, summary: string, value: string }], total_opportunities: number }',
    });
    expect(parsed.error).toBeUndefined();
  });

  test('rejects prototype-mutating field names', () => {
    const parsed = parseWorkflowExpectedOutputContract(
      '{"__proto__":{"required":"text"}}',
    );

    expect(parsed).toMatchObject({
      structured: true,
      error: expect.stringContaining('__proto__'),
    });
    expect(parsed.shape).toBeUndefined();
  });

  test('rejects top-level arrays because plan_result.data is an object', () => {
    const parsed = parseWorkflowExpectedOutputContract(
      '[{"url":"url"}]',
    );

    expect(parsed).toMatchObject({
      structured: true,
      error: expect.stringContaining('must describe a data object'),
    });
    expect(parsed.shape).toBeUndefined();
  });
});
