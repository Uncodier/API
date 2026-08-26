import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';

export class PromotionError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'PromotionError';
    this.statusCode = statusCode;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const uuid = z.string().uuid();
const DiscountType = z.enum(['percent', 'fixed', 'bogo']);
const Status = z.enum(['draft', 'active', 'paused', 'expired']);
const AppliesTo = z.enum(['all', 'selected_items']);
const Channel = z.enum(['marketplace', 'shop', 'pos']);
const RequiredItemsMode = z.enum(['all', 'any']);

const RequiredItemSchema = z.object({
  catalog_item_id: uuid,
  min_quantity: z.number().int().min(1).optional(),
});

const RequiredCategorySchema = z.object({
  catalog_category_id: uuid,
  min_quantity: z.number().int().min(1).optional(),
});

const JunctionsSchema = z.object({
  catalog_item_ids: z.array(uuid).optional(),
  catalog_category_ids: z.array(uuid).optional(),
  required_items: z.array(RequiredItemSchema).optional(),
  required_categories: z.array(RequiredCategorySchema).optional(),
});

const PromotionFields = {
  description: z.string().nullable().optional(),
  code: z.string().nullable().optional(),
  applies_to: AppliesTo.optional(),
  min_order_amount: z.coerce.number().nullable().optional(),
  usage_limit: z.coerce.number().int().nullable().optional(),
  usage_limit_per_user: z.coerce.number().int().nullable().optional(),
  status: Status.optional(),
  starts_at: z.string().nullable().optional(),
  ends_at: z.string().nullable().optional(),
  channels: z.array(Channel).min(1).optional(),
  location_ids: z.array(uuid).optional(),
  active_weekdays: z.array(z.number().int().min(0).max(6)).optional(),
  required_items_mode: RequiredItemsMode.optional(),
  bogo_buy_qty: z.coerce.number().int().min(1).optional(),
  bogo_get_qty: z.coerce.number().int().min(1).optional(),
  image_url: z.string().nullable().optional(),
  show_on_shop: z.boolean().optional(),
  show_on_marketplace: z.boolean().optional(),
  currency: z.string().nullable().optional(),
};

const CreateSchema = z
  .object({
    site_id: uuid,
    user_id: uuid.optional(),
    campaign_id: uuid,
    name: z.string().min(1),
    discount_type: DiscountType,
    discount_value: z.coerce.number(),
    ...PromotionFields,
  })
  .merge(JunctionsSchema)
  .superRefine((data, ctx) => validateDiscountAndTargets(data, ctx, 'create'));

const UpdateSchema = z
  .object({
    id: uuid,
    site_id: uuid,
    campaign_id: uuid.optional(),
    name: z.string().min(1).optional(),
    discount_type: DiscountType.optional(),
    discount_value: z.coerce.number().optional(),
    ...PromotionFields,
  })
  .merge(JunctionsSchema)
  .superRefine((data, ctx) => validateDiscountAndTargets(data, ctx, 'update'));

const ListSchema = z.object({
  site_id: uuid,
  status: Status.optional(),
  campaign_id: uuid.optional(),
  code: z.string().optional(),
  search: z.string().optional(),
  active_now: z.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

const GetSchema = z.object({
  id: uuid,
  site_id: uuid,
});

const PROMOTION_EMBED =
  '*, catalog_items:promotion_catalog_items(id, catalog_item_id), catalog_categories:promotion_catalog_categories(id, catalog_category_id), required_items:promotion_required_items(id, catalog_item_id, min_quantity), required_categories:promotion_required_categories(id, catalog_category_id, min_quantity)';

const WRITABLE_FIELDS = [
  'name',
  'description',
  'code',
  'discount_type',
  'discount_value',
  'applies_to',
  'min_order_amount',
  'usage_limit',
  'usage_limit_per_user',
  'status',
  'starts_at',
  'ends_at',
  'channels',
  'location_ids',
  'active_weekdays',
  'required_items_mode',
  'bogo_buy_qty',
  'bogo_get_qty',
  'image_url',
  'show_on_shop',
  'show_on_marketplace',
  'currency',
  'campaign_id',
] as const;

type JunctionInput = z.infer<typeof JunctionsSchema>;

function validateDiscountAndTargets(
  data: {
    discount_type?: string;
    discount_value?: number;
    applies_to?: string;
    catalog_item_ids?: string[];
    catalog_category_ids?: string[];
  },
  ctx: z.RefinementCtx,
  mode: 'create' | 'update'
) {
  if (data.discount_type === 'percent' && data.discount_value != null) {
    if (data.discount_value < 0 || data.discount_value > 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'percent discount_value must be between 0 and 100',
        path: ['discount_value'],
      });
    }
  }

  if (data.applies_to !== 'selected_items') return;

  const hasTargets =
    (data.catalog_item_ids?.length ?? 0) > 0 || (data.catalog_category_ids?.length ?? 0) > 0;
  const providedTargets =
    data.catalog_item_ids !== undefined || data.catalog_category_ids !== undefined;

  if (mode === 'create' && !hasTargets) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'applies_to=selected_items requires catalog_item_ids or catalog_category_ids',
      path: ['applies_to'],
    });
    return;
  }

  if (mode === 'update' && providedTargets && !hasTargets) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'applies_to=selected_items requires catalog_item_ids or catalog_category_ids',
      path: ['applies_to'],
    });
  }
}

function pickDefined(source: Record<string, unknown>, keys: readonly string[]) {
  const payload: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) payload[key] = source[key];
  }
  return payload;
}

function normalizeCode(code: string | null | undefined) {
  if (code == null) return code;
  const trimmed = String(code).trim();
  return trimmed.length ? trimmed : null;
}

function mapDbError(error: { code?: string; message?: string }): never {
  const message = error.message || 'Database error';
  if (error.code === '23505' || /duplicate key|unique/i.test(message)) {
    throw new PromotionError('Promotion code already exists for this site', 400);
  }
  if (error.code === '23503') {
    throw new PromotionError(message, 400);
  }
  if (error.code === 'PGRST116') {
    throw new PromotionError('Promotion not found', 404);
  }
  throw new Error(message);
}

async function resolveUserId(siteId: string, userId?: string): Promise<string> {
  if (userId) return userId;
  const { data, error } = await supabaseAdmin
    .from('sites')
    .select('user_id')
    .eq('id', siteId)
    .single();
  if (error || !data?.user_id) {
    throw new PromotionError('user_id required: provide it or ensure site has user_id', 400);
  }
  return data.user_id as string;
}

async function fetchPromotion(id: string, siteId: string) {
  const { data, error } = await supabaseAdmin
    .from('promotions')
    .select(PROMOTION_EMBED)
    .eq('id', id)
    .eq('site_id', siteId)
    .single();

  if (error) mapDbError(error);
  return data;
}

async function replaceUuidJunction(
  table: string,
  promotionId: string,
  siteId: string,
  fkColumn: string,
  ids: string[] | undefined
) {
  if (ids === undefined) return;
  const { error: deleteError } = await supabaseAdmin
    .from(table)
    .delete()
    .eq('promotion_id', promotionId)
    .eq('site_id', siteId);
  if (deleteError) mapDbError(deleteError);
  if (ids.length === 0) return;
  const { error } = await supabaseAdmin.from(table).insert(
    ids.map((id) => ({
      promotion_id: promotionId,
      site_id: siteId,
      [fkColumn]: id,
    }))
  );
  if (error) mapDbError(error);
}

async function replaceRequiredJunction(
  table: string,
  promotionId: string,
  siteId: string,
  fkColumn: string,
  rows:
    | Array<{ catalog_item_id?: string; catalog_category_id?: string; min_quantity?: number }>
    | undefined
) {
  if (rows === undefined) return;
  const { error: deleteError } = await supabaseAdmin
    .from(table)
    .delete()
    .eq('promotion_id', promotionId)
    .eq('site_id', siteId);
  if (deleteError) mapDbError(deleteError);
  if (rows.length === 0) return;
  const { error } = await supabaseAdmin.from(table).insert(
    rows.map((row) => ({
      promotion_id: promotionId,
      site_id: siteId,
      [fkColumn]: row[fkColumn as 'catalog_item_id' | 'catalog_category_id'],
      min_quantity: row.min_quantity ?? 1,
    }))
  );
  if (error) mapDbError(error);
}

async function syncJunctions(promotionId: string, siteId: string, input: JunctionInput) {
  await replaceUuidJunction(
    'promotion_catalog_items',
    promotionId,
    siteId,
    'catalog_item_id',
    input.catalog_item_ids
  );
  await replaceUuidJunction(
    'promotion_catalog_categories',
    promotionId,
    siteId,
    'catalog_category_id',
    input.catalog_category_ids
  );
  await replaceRequiredJunction(
    'promotion_required_items',
    promotionId,
    siteId,
    'catalog_item_id',
    input.required_items
  );
  await replaceRequiredJunction(
    'promotion_required_categories',
    promotionId,
    siteId,
    'catalog_category_id',
    input.required_categories
  );
}

function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path?.length ? `${first.path.join('.')}: ` : '';
    throw new PromotionError(`${path}${first?.message || 'Invalid promotion payload'}`, 400);
  }
  return parsed.data;
}

function quoteOrValue(value: string) {
  return `"${value.replace(/"/g, '')}"`;
}

export async function listPromotions(input: unknown) {
  const filters = parseOrThrow(ListSchema, input);
  let query = supabaseAdmin.from('promotions').select(PROMOTION_EMBED, { count: 'exact' }).eq(
    'site_id',
    filters.site_id
  );

  if (filters.status) query = query.eq('status', filters.status);
  if (filters.campaign_id) query = query.eq('campaign_id', filters.campaign_id);
  if (filters.code) query = query.eq('code', filters.code);
  if (filters.search) {
    const term = filters.search.replace(/[%_,()]/g, ' ').trim();
    if (term) query = query.or(`name.ilike.%${term}%,code.ilike.%${term}%`);
  }
  if (filters.active_now) {
    const now = quoteOrValue(new Date().toISOString());
    query = query.or(`starts_at.is.null,starts_at.lte.${now}`);
    query = query.or(`ends_at.is.null,ends_at.gte.${now}`);
  }

  const { data, error, count } = await query
    .range(filters.offset, filters.offset + filters.limit - 1)
    .order('created_at', { ascending: false });

  if (error) mapDbError(error);
  return { promotions: data || [], count: count ?? 0 };
}

export async function getPromotion(input: unknown) {
  const { id, site_id } = parseOrThrow(GetSchema, input);
  const promotion = await fetchPromotion(id, site_id);
  return { promotion };
}

export async function createPromotion(input: unknown) {
  const data = parseOrThrow(CreateSchema, input);
  const userId = await resolveUserId(data.site_id, data.user_id);
  const payload = {
    ...pickDefined(data as Record<string, unknown>, WRITABLE_FIELDS),
    site_id: data.site_id,
    user_id: userId,
    campaign_id: data.campaign_id,
    name: data.name,
    discount_type: data.discount_type,
    discount_value: data.discount_value,
    code: normalizeCode(data.code),
  };

  const { data: created, error } = await supabaseAdmin
    .from('promotions')
    .insert(payload)
    .select('id')
    .single();

  if (error || !created?.id) mapDbError(error || { message: 'Failed to create promotion' });

  await syncJunctions(created.id, data.site_id, data);
  const promotion = await fetchPromotion(created.id, data.site_id);
  return { promotion };
}

export async function updatePromotion(input: unknown) {
  const data = parseOrThrow(UpdateSchema, input);
  const payload = {
    ...pickDefined(data as Record<string, unknown>, WRITABLE_FIELDS),
    updated_at: new Date().toISOString(),
  };
  if (data.code !== undefined) payload.code = normalizeCode(data.code);

  const { error } = await supabaseAdmin
    .from('promotions')
    .update(payload)
    .eq('id', data.id)
    .eq('site_id', data.site_id)
    .select('id')
    .single();
  if (error) mapDbError(error);

  await syncJunctions(data.id, data.site_id, data);
  const promotion = await fetchPromotion(data.id, data.site_id);
  return { promotion };
}

export async function deletePromotion(input: unknown) {
  const { id, site_id } = parseOrThrow(GetSchema, input);
  const { data, error } = await supabaseAdmin
    .from('promotions')
    .delete()
    .eq('id', id)
    .eq('site_id', site_id)
    .select('id')
    .single();

  if (error || !data?.id) mapDbError(error || { code: 'PGRST116', message: 'Promotion not found' });
  return { deleted: true, id: data.id };
}
