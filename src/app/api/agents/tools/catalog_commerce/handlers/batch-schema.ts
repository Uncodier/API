import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

const uuid = z.string().uuid();
const money = z.number().finite().nonnegative();
export const batchChangesSchema = z.object({
  name: z.string().trim().min(1).max(500).optional(),
  description: z.string().max(20000).nullable().optional(),
  status: z.enum(['active', 'archived']).optional(),
  availability_status: z.enum(['available', 'unavailable', 'sold_out']).optional(),
  is_marketplace_listed: z.boolean().optional(),
  is_pos_available: z.boolean().optional(),
  is_purchasable: z.boolean().optional(),
  is_reservation: z.boolean().optional(),
  is_recurring: z.boolean().optional(),
  cost: money.optional(),
  lowest_sale_price: money.optional(),
  target_sale_price: money.optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  sort_order: z.number().int().optional(),
  pass_uses: z.number().int().positive().nullable().optional(),
  pass_validity_days: z.number().int().positive().nullable().optional(),
}).strict();

export const batchFields = {
  item_ids: z.array(uuid).min(1).max(1000).optional(),
  all_items: z.boolean().optional().describe('Explicitly select the entire site catalog, including archived items and variants. Maximum 1000 items.'),
  changes: batchChangesSchema.optional().describe('Common patch. Omitted properties and prices remain unchanged. Channel flags are independent; availability still inherits from parents.'),
  taxes: z.object({ mode: z.enum(['add', 'remove']), tax_ids: z.array(uuid).min(1).max(20) }).strict().optional()
    .describe('Add preserves other taxes; remove only detaches specified taxes. Never changes base prices.'),
  inventory: z.object({ location_id: uuid, quantity: money }).strict().optional()
    .describe('Set absolute quantity for each selected item at this existing site location. Does not transfer stock or change other locations.'),
  dry_run: z.boolean().default(true).describe('Defaults to true: preview without writes. Set false only after reviewing the selection.'),
  expected_count: z.number().int().min(1).max(1000).optional().describe('Required for execution; must match the selected count from preview.'),
};

export const batchUpdateSchema = z.object({
  action: z.literal('batch_update'), resource: z.literal('item').default('item'),
  site_id: uuid, ...batchFields,
}).strict().superRefine((input, ctx) => {
  if (Boolean(input.item_ids) === (input.all_items === true)) {
    ctx.addIssue({ code: 'custom', message: 'Select exactly one of item_ids or all_items=true' });
  }
  if (input.item_ids && new Set(input.item_ids).size !== input.item_ids.length) {
    ctx.addIssue({ code: 'custom', message: 'Duplicate item_ids are not allowed' });
  }
  if (!Object.keys(input.changes || {}).length && !input.taxes && !input.inventory) {
    ctx.addIssue({ code: 'custom', message: 'Provide changes, taxes or inventory' });
  }
  if (!input.dry_run && input.expected_count === undefined) {
    ctx.addIssue({ code: 'custom', message: 'Execution requires expected_count from preview' });
  }
});

export type BatchUpdateInput = z.infer<typeof batchUpdateSchema>;
export const batchToolProperties = (zodToJsonSchema(z.object(batchFields), { $refStrategy: 'none' }) as { properties: Record<string, unknown> }).properties;