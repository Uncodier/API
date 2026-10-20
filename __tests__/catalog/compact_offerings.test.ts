import { compactConfiguredOfferings, CONFIGURED_OFFERINGS_MAX_CHARS } from '@/lib/agentbase/services/agent/BackgroundServices/compact-offerings';
import { BackgroundBuilder } from '@/lib/agentbase/services/agent/BackgroundServices/BackgroundBuilder';

jest.mock('@/lib/timezone', () => ({ buildDateContextSection: () => '# Server Date\n2026-10-19' }));

const products = Array.from({ length: 3000 }, (_, index) => ({
  name: `Product ${index}`, cost: 7, lowest_sale_price: 8, target_sale_price: 9,
  metadata: { private_note: 'NEVER_OUTPUT_PRIVATE_NOTE' }, description: 'NEVER_OUTPUT_DESCRIPTION',
}));

it('bounds 3000 products and services jointly with exact omission counts and names only', () => {
  const result = compactConfiguredOfferings(products, [{ name: 'Personal consultation' }]);
  expect(result.length).toBeLessThanOrEqual(CONFIGURED_OFFERINGS_MAX_CHARS);
  expect(result).toContain('Product 0');
  expect(result).toContain('Personal consultation');
  expect(result).toContain('## Products');
  expect(result).toContain('## Services');
  const count = result.match(/Shown (\d+) of 3000; omitted (\d+)/)!;
  expect(Number(count[1]) + Number(count[2])).toBe(3000);
  expect(Number(count[2])).toBeGreaterThan(2900);
  expect(result).toContain('catalog_commerce');
  expect(result).toContain('prices and availability');
  for (const field of ['cost', 'metadata', 'target_sale_price', 'lowest_sale_price', 'NEVER_OUTPUT_PRIVATE_NOTE', 'NEVER_OUTPUT_DESCRIPTION']) {
    expect(result).not.toContain(field);
  }
  expect(compactConfiguredOfferings(products, [{ name: 'Personal consultation' }])).toBe(result);
});

it('parses stringified JSON arrays but never dumps malformed or object settings', () => {
  expect(compactConfiguredOfferings(JSON.stringify(products), '[]'))
    .toBe(compactConfiguredOfferings(products, []));
  const result = compactConfiguredOfferings('{private broken JSON', { metadata: 'DO_NOT_SERIALIZE' });
  expect(result).toContain('count unknown');
  expect(result).not.toContain('private broken JSON');
  expect(result).not.toContain('DO_NOT_SERIALIZE');
  expect(result.length).toBeLessThanOrEqual(CONFIGURED_OFFERINGS_MAX_CHARS);
});

it('handles huge names, escaped text and many unnamed entries deterministically', () => {
  const large = [{ name: 'X'.repeat(1_000_000) }, ...Array.from({ length: 2999 }, () => ({ name: '"\\\n'.repeat(1000) }))];
  const result = compactConfiguredOfferings(JSON.stringify(large), large);
  expect(result.length).toBeLessThanOrEqual(CONFIGURED_OFFERINGS_MAX_CHARS);
  expect(result).toContain('…');
  expect(result).toContain('omitted');
  expect(compactConfiguredOfferings(new Array(3000).fill({ cost: 123 }), undefined))
    .toContain('Shown 0 of 3000; omitted 3000');
});

it('accepts configured plain names and reports invalid entries as omitted', () => {
  const result = compactConfiguredOfferings(['Tea', null, { name: 'Coffee' }, { sku: 'not-a-name' }], undefined);
  expect(result).toContain('"Tea"');
  expect(result).toContain('"Coffee"');
  expect(result).toContain('Shown 2 of 4; omitted 2');
  expect(compactConfiguredOfferings(undefined, null)).toBe('');
});

it('BackgroundBuilder embeds the compact summary instead of full settings JSON', () => {
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const prompt = BackgroundBuilder.buildAgentPrompt('agent', 'Support', 'Help customers', [],
      undefined, undefined, undefined, { site: { name: 'Test Business' }, settings: { products, services: ['Consultation'] } });
    expect(prompt).toContain(compactConfiguredOfferings(products, ['Consultation']));
    expect(prompt).toContain('Product 0');
    expect(prompt).not.toContain('Product 2999');
    expect(prompt).not.toContain('NEVER_OUTPUT_PRIVATE_NOTE');
    expect(prompt).not.toContain('"cost"');
  } finally { log.mockRestore(); }
});