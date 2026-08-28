import { buildWriteIdempotencyKey, canonicalJson } from '../write-idempotency';

describe('write-idempotency', () => {
  it('is stable for the same command, tool, action, and args', () => {
    const args = { catalog_item_id: 'item-1', lead_id: 'lead-1', quantity: 1 };
    const a = buildWriteIdempotencyKey('cmd-1', 'reservations', 'create', args);
    const b = buildWriteIdempotencyKey('cmd-1', 'reservations', 'create', { quantity: 1, lead_id: 'lead-1', catalog_item_id: 'item-1' });
    expect(a).toBe(b);
    expect(a).toContain('cmd-1:reservations:create:');
  });

  it('ignores command_id in the hashed args', () => {
    const base = { action: 'create', catalog_item_id: 'item-1' };
    const a = buildWriteIdempotencyKey('cmd-1', 'reservations', 'create', base);
    const b = buildWriteIdempotencyKey('cmd-1', 'reservations', 'create', { ...base, command_id: 'cmd-1' });
    expect(a).toBe(b);
    expect(canonicalJson({ ...base, command_id: 'x' })).toBe(canonicalJson(base));
  });

  it('changes when write args change', () => {
    const a = buildWriteIdempotencyKey('cmd-1', 'checkout', 'create_order', { lines: [{ catalogItemId: 'a' }] });
    const b = buildWriteIdempotencyKey('cmd-1', 'checkout', 'create_order', { lines: [{ catalogItemId: 'b' }] });
    expect(a).not.toBe(b);
  });
});
