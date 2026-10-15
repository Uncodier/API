import { calculateOpenRouterCreditCharge, OPENROUTER_COST_MULTIPLIER } from '../agent-pricing';

describe('OpenRouter product credit pricing', () => {
  it('uses provider cost with the approved 25% markup', () => {
    expect(OPENROUTER_COST_MULTIPLIER).toBe(1.25);
    expect(calculateOpenRouterCreditCharge({ cost: 0.04, prompt_tokens: 10000, completion_tokens: 2000 }))
      .toBeCloseTo(0.05, 12);
  });
  it('keeps reported zero distinct from missing actual cost', () => {
    expect(calculateOpenRouterCreditCharge({ cost: 0 })).toBe(0);
  });
  it.each([undefined, null, {}, { cost: undefined }, { cost: -1 }, { cost: NaN },
    { cost: Infinity }, { cost: '0.01' }, { prompt_tokens: 10, completion_tokens: 5 }])(
    'requires reconciliation rather than estimating unknown/invalid usage %j', usage => {
      expect(() => calculateOpenRouterCreditCharge(usage)).toThrow('requires reconciliation');
    },
  );
  it('uses only the final reported cost, not upstream breakdown or reasoning/cached tokens', () => {
    expect(calculateOpenRouterCreditCharge({ cost: 0.01, cost_details: { upstream_inference_cost: 99 },
      completion_tokens_details: { reasoning_tokens: 5000 }, prompt_tokens_details: { cached_tokens: 10000 } }))
      .toBeCloseTo(0.0125, 12);
  });
});