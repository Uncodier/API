import { describe, expect, it } from '@jest/globals';
import { evaluateScenarioSelection } from '../qa-scenario-selection';

describe('QA scenario selection', () => {
  it('fails when no scenarios are available', () => {
    expect(evaluateScenarioSelection([])).toEqual({
      selected: [],
      unresolved: [],
      ok: false,
    });
  });

  it('fails when any requested scenario cannot be resolved', () => {
    const result = evaluateScenarioSelection([
      { scenario: 'checkout.json', pass: true },
    ], ['checkout', 'refund']);

    expect(result.selected).toHaveLength(1);
    expect(result.unresolved).toEqual(['refund']);
    expect(result.ok).toBe(false);
  });
});