import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

const uuid = z.string().uuid();
const uniqueIds = z.array(uuid).min(1).max(1000).refine(ids => new Set(ids).size === ids.length, 'Duplicate IDs');
const fields = {
  name: z.string().trim().min(1).max(500),
  code: z.string().trim().min(1).max(100).nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  is_active: z.boolean(),
  // Promotion changes other lists and needs a transactional default-switch API.
  is_default: z.literal(false),
  channels: z.array(z.enum(['pos', 'shop', 'marketplace'])).min(1).max(3)
    .refine(values => new Set(values).size === values.length, 'Duplicate channels'),
};
export const priceListChangesSchema = z.object(fields).partial().strict();
const item = z.object({ catalog_item_id: uuid, unit_price: z.number().finite().nonnegative() }).strict();
const items = z.array(item).min(1).max(1000)
  .refine(rows => new Set(rows.map(row => row.catalog_item_id)).size === rows.length, 'Duplicate catalog items');
const list = priceListChangesSchema.extend({
  name: fields.name, currency: fields.currency,
  items: items.optional(),
}).strict();
const itemChanges = z.object({ set: items.optional(), remove: uniqueIds.optional() }).strict();
const update = z.object({ id: uuid, changes: priceListChangesSchema.optional(), items: itemChanges.optional() }).strict();

export const batchFields = {
  lists: z.array(list).min(1).max(1000).optional(),
  price_list_ids: uniqueIds.optional(),
  updates: z.array(update).min(1).max(1000).optional(),
  changes: priceListChangesSchema.optional(),
  items: itemChanges.optional(),
  dry_run: z.boolean().default(true),
  expected_count: z.number().int().min(1).max(1000).optional(),
};
export const priceListBatchSchema = z.object({
  action: z.enum(['batch_create', 'batch_update']), site_id: uuid, ...batchFields,
}).strict().superRefine((input, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (!input.dry_run && input.expected_count === undefined) issue('Execution requires expected_count from preview');
  if (input.action === 'batch_create') {
    if (!input.lists || input.price_list_ids || input.updates || input.changes || input.items) issue('batch_create requires only lists');
    if ((input.lists || []).reduce((sum, row) => sum + (row.items?.length || 0), 0) > 1000) {
      issue('Maximum 1000 item prices per request');
    }
  } else {
    if (Boolean(input.price_list_ids) === Boolean(input.updates) || input.lists) issue('Select price_list_ids or updates, not both');
    if (input.updates && (input.changes || input.items)) issue('updates cannot include common changes/items');
    if (input.updates && new Set(input.updates.map(row => row.id)).size !== input.updates.length) issue('Duplicate list IDs');
    const rows = input.updates || (input.price_list_ids || []).map(id => ({ id, changes: input.changes, items: input.items }));
    let count = 0;
    for (const row of rows) {
      if (!Object.keys(row.changes || {}).length && !row.items?.set && !row.items?.remove) issue('Provide changes or item set/remove operations');
      const remove = new Set(row.items?.remove);
      if (row.items?.set?.some(item => remove.has(item.catalog_item_id))) issue('Cannot set and remove the same item');
      count += (row.items?.set?.length || 0) + (row.items?.remove?.length || 0);
    }
    if (count > 1000) issue('Maximum 1000 item price operations per request');
  }
});

export type PriceListBatchInput = z.infer<typeof priceListBatchSchema>;
export const priceListBatchProperties = (zodToJsonSchema(z.object(batchFields), { $refStrategy: 'none' }) as {
  properties: Record<string, unknown>;
}).properties;