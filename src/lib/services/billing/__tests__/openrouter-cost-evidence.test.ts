import { randomBytes } from 'node:crypto';
import { openRouterCostEvidence } from '../openrouter-cost-evidence';

it('preserves zero gateway spend and separate positive BYOK spend', () => {
  expect(openRouterCostEvidence({ cost: 0, is_byok: true,
    cost_details: { upstream_inference_cost: 0.125 } })).toEqual({
    gateway_account_cost: 0, is_byok: true, upstream_inference_cost: 0.125,
    external_cost_reconciliation_required: true,
  });
});

it.each([undefined, null, 'usage', {}, { cost: NaN }, { cost: Infinity },
  { cost: -1 }, { cost_details: { upstream_inference_cost: -1 } },
  { cost_details: { upstream_inference_cost: Infinity } }, { is_byok: 'true' }])(
  'does not manufacture accounting evidence from malformed usage %j', usage => {
    expect(openRouterCostEvidence(usage)).toEqual({});
  },
);

it('never retains sensitive provider fields or arbitrary content', () => {
  const credential = randomBytes(24).toString('hex');
  const username = randomBytes(12).toString('hex');
  const url = new URL('https://provider.example.test/usage');
  url.username = username; url.password = credential;
  const evidence = openRouterCostEvidence({ cost: 0.04, is_byok: false,
    apiKey: credential, url: url.href,
    cost_details: { upstream_inference_cost: 0.03, password: credential, username },
  });
  expect(evidence).toEqual({ gateway_account_cost: 0.04, is_byok: false, upstream_inference_cost: 0.03 });
  const serialized = JSON.stringify(evidence);
  expect(serialized).not.toContain(credential);
  expect(serialized).not.toContain(username);
  expect(serialized).not.toContain(url.href);
});