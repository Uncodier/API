import { z } from 'zod';

// Contracts mirror market-fit/app/purchases/{requests,tenders}/schema.ts and
// procurement/commerce/contracts.ts. Money here is integer minor units, NOT AP decimals.
export const uuid = z.string().uuid().transform(value => value.toLowerCase());
const version = z.number().int().min(1).max(2147483646);
const revision = z.number().int().min(0).max(2147483646);
const money = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const currency = z.enum(['USD', 'MXN', 'EUR', 'GBP', 'CAD']);
const timestamp = z.string().datetime({ offset: true }).refine(v => Number.isFinite(Date.parse(v)));
const thought = { thought_process: z.string().max(2000).optional() };
const object = <T extends z.ZodRawShape>(shape: T) => z.object({ ...shape, ...thought }).strict();
const id = { id: uuid };
const decision = { stage_id: uuid, decision: z.enum(['approve', 'reject']), reason: z.string().trim().min(1).max(2000) };
const page = { limit: z.number().int().min(1).max(100).default(50), offset: z.number().int().min(0).max(10000).default(0) };

const requestLine = z.object({
  catalog_item_id: uuid.nullable(), description: z.string().trim().max(500).default(''),
  quantity: z.number().int().min(1).max(1000000), unit_estimate_minor: money.optional(),
  tax_ids: z.array(uuid).max(20).optional(),
}).strict().superRefine((v, ctx) => {
  if ((!v.catalog_item_id && !v.description) || (v.catalog_item_id && (v.unit_estimate_minor !== undefined || v.tax_ids !== undefined))
    || (v.unit_estimate_minor !== undefined && v.tax_ids === undefined)) {
    ctx.addIssue({ code: 'custom', message: 'Select a catalog item without price overrides, or describe a service with an estimate and explicit taxes.' });
  }
});
export const requestDocument = z.object({
  title: z.string().trim().min(1).max(200), description: z.string().max(5000).default(''),
  currency, lines: z.array(requestLine).min(1).max(100),
}).strict();
export const tenderDocument = z.object({
  title: z.string().trim().min(1).max(200), description: z.string().trim().max(10000), request_id: uuid.nullable(), currency,
  visibility: z.enum(['public', 'unlisted', 'private']), global_visible: z.boolean(),
  participation: z.enum(['open', 'invitation_only', 'approved_suppliers']), opening_policy: z.enum(['on_receipt', 'after_close']),
  participation_deadline: timestamp, opening_at: timestamp,
  requirements: z.array(z.object({
    id: uuid, description: z.string().trim().min(1).max(2000), quantity: z.number().int().min(1).max(1000000),
    unit: z.string().trim().min(1).max(40), unit_net_minor: money, catalog_item_id: uuid.nullable().default(null),
  }).strict()).min(1).max(100),
}).strict().superRefine((v, ctx) => {
  if (v.global_visible && v.visibility !== 'public') ctx.addIssue({ code: 'custom', message: 'Global discovery requires public visibility.' });
  if (v.opening_policy === 'after_close' && Date.parse(v.opening_at) < Date.parse(v.participation_deadline)) ctx.addIssue({ code: 'custom', message: 'Opening must follow participation closing.' });
  if (!Number.isSafeInteger(v.requirements.reduce((sum, line) => sum + line.quantity * line.unit_net_minor, 0))) ctx.addIssue({ code: 'custom', message: 'Estimate exceeds supported range.' });
  if (new Set(v.requirements.map(line => line.id)).size !== v.requirements.length) ctx.addIssue({ code: 'custom', message: 'Duplicate requirement IDs.' });
});
const quotation = z.object({
  supplier_id: uuid, tender_id: uuid, publication_id: uuid, reference: z.string().trim().min(1).max(120), idempotency_key: uuid,
  lines: z.array(z.object({ requirement_id: uuid, unit_net_minor: z.number().int().min(0).max(1000000000) }).strict()).min(1).max(100),
}).strict().refine(v => new Set(v.lines.map(l => l.requirement_id)).size === v.lines.length, 'Duplicate quotation lines.');
const receipt = z.object({
  order_id: uuid, idempotency_key: uuid, note: z.string().trim().min(1).max(1000),
  lines: z.array(z.object({ item_id: uuid, quantity: z.number().int().min(1).max(1000000) }).strict()).min(1).max(100),
}).strict().refine(v => new Set(v.lines.map(l => l.item_id)).size === v.lines.length, 'Duplicate receipt lines.');
const saveVersion = (v: { id?: string; expected_version?: number; expected_revision?: number }) =>
  v.id ? (v.expected_version ?? v.expected_revision ?? 0) > 0 : (v.expected_version ?? v.expected_revision) === 0;

export const procurementSchemas = {
  procurement_requests: {
    list: object({ ...page, status: z.enum(['draft', 'submitted', 'approved', 'rejected', 'returned']).optional(), query: z.string().trim().max(200).optional() }),
    get: object(id),
    save: object({ id: uuid.optional(), expected_revision: revision, document: requestDocument }).refine(saveVersion, 'Create at revision zero; edits require the current revision.'),
    submit: object({ ...id, expected_revision: version }),
    revalidate: object({ ...id, expected_revision: version }),
    decide: object({ ...id, expected_revision: version, ...decision }),
  },
  procurement_tenders: {
    list: object({ ...page, status: z.enum(['draft', 'published', 'closed', 'cancelled']).optional(), query: z.string().trim().max(200).optional() }),
    get: object(id),
    save: object({ id: uuid.optional(), expected_version: revision, document: tenderDocument }).refine(saveVersion, 'Create at version zero; edits require the current version.'),
    publish: object({ ...id, expected_version: version }),
    transition: object({ ...id, expected_version: version, transition: z.enum(['close', 'cancel', 'delete']) }),
    participant: object({ ...id, expected_version: version, supplier_id: uuid, status: z.enum(['invited', 'withdrawn']) }),
    portal: object({ enabled: z.boolean() }),
  },
  procurement_quotations: {
    list: object({}), get: object(id), options: object({}), record: object({ document: quotation }),
  },
  procurement_orders: { list: object({}), receive: object({ document: receipt }) },
  procurement_approvals: {
    list: object({ ...page, status: z.enum(['pending', 'approved', 'rejected']).optional() }),
    get: object(id),
    create: object({ target_id: uuid, expected_version: version, event: z.enum(['award', 'order']) }),
    decide: object({ ...id, ...decision }),
  },
  procurement_policy: { get: object({}) },
} satisfies Record<string, Record<string, z.ZodTypeAny>>;

export type ProcurementToolName = keyof typeof procurementSchemas;