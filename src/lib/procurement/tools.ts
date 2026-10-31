import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { assertToolScreenAccess, type ToolScreenScope } from '@/app/api/agents/tools/router/screen-access';
import { procurementSchemas, uuid, type ProcurementToolName } from './schemas';

const descriptions: Record<ProcurementToolName, string> = {
  procurement_requests: 'Manage procurement requisitions (solicitudes de compra): list/get, save a complete draft, submit to policy approvals, revalidate into a new revision, or record an eligible human decision with reason. Save without id at expected_revision=0 to create; edits require current revision. Not legacy vendor bills. Amounts are integer minor units. Manager-only.',
  procurement_tenders: 'Manage licitaciones, concursos and invitation-only sourcing: list/get, save full draft, request publication approval, close/cancel/delete through transition, invite/withdraw suppliers with participant, enable/disable portal. Read current version before mutations. Invitations record eligibility; they DO NOT send email. publish can return pending approval, not a published release. Manager-only.',
  procurement_quotations: 'Read procurement supplier proposals respecting sealed opening rules. list includes safe envelopes; get reads one quotation; options returns eligible published tenders/suppliers; record imports a buyer-recorded proposal with an explicit stable idempotency_key. Reuse the same key and payload on retry. Not sales quotations. Lists are the latest 100, not exhaustive. Manager-only.',
  procurement_orders: 'List canonical procurement purchase orders or receive a partial/full non-stock acceptance with stable idempotency_key. Receipt quantities cannot exceed outstanding quantities. Does NOT move inventory, post accounting, pay a vendor or modify legacy purchases. Orders are created only through procurement_approvals event=order. List is latest 100. Manager-only.',
  procurement_approvals: 'Inspect policy approvals and record approve/reject decisions with an explicit reason. create event=award targets a quotation ID/current procurement_revision; event=order targets an award ID/version 1. The server resolves current and inherited policy; a pending approval is NOT an award/order. Read the resulting approval to confirm. Pending approval requires an unchanged MCP evaluation snapshot; historical/UI approvals without one must be resolved in the UI. A stale snapshot requires a revised target/policy, not a blind create retry. Never bypass mandatory approvals or treat an AI recommendation as a human vote. Manager-only, and decisions still require configured approver eligibility.',
  procurement_policy: 'Read the current saved procurement policy and revision before planning purchasing, tenders, invitations, awards or orders. This tool cannot change rules or relax approvals. Missing/blocked policy prevents progression. Manager-only.',
};

export type ProcurementRpc = (operation: string, args: Record<string, unknown>) => Promise<unknown>;

/** Bound only by the host, never by model-supplied tenant, actor, plan or RPC name. */
export function createProcurementTools(scope: ToolScreenScope, options: { rpc?: ProcurementRpc } = {}) {
  const bound = { siteId: scope.siteId, userId: scope.userId };
  return Object.entries(procurementSchemas).map(([name, actions]) => {
    const schemas = actions as Record<string, z.ZodTypeAny>;
    // Root properties support the MCP server's shallow argument checker; oneOf
    // documents each action while execution ALWAYS parses the exact strict schema.
    const variants = Object.entries(schemas).map(([action, schema]) => {
      const json = zodToJsonSchema(schema, { $refStrategy: 'none' }) as any;
      return { ...json, properties: { action: { const: action, type: 'string' }, ...json.properties }, required: ['action', ...(json.required ?? [])] };
    });
    const properties: Record<string, any> = {};
    for (const variant of variants) {
      for (const [key, value] of Object.entries(variant.properties)) {
        if (key === 'action') continue;
        const choices = properties[key]?.anyOf ?? (properties[key] ? [properties[key]] : []);
        if (!choices.some((choice: unknown) => JSON.stringify(choice) === JSON.stringify(value))) choices.push(value);
        properties[key] = choices.length === 1 ? choices[0] : { anyOf: choices };
      }
    }
    properties.action = { type: 'string', enum: Object.keys(schemas) };
    return {
      name, description: descriptions[name as ProcurementToolName],
      parameters: { type: 'object', properties, required: ['action'], additionalProperties: false, oneOf: variants },
      execute: async (raw: unknown) => {
        if (!uuid.safeParse(bound.siteId).success || !uuid.safeParse(bound.userId).success) throw new Error('Procurement requires a verified workspace and user.');
        await assertToolScreenAccess(name, bound);
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Procurement arguments must be an object.');
        const { action, ...fields } = raw as Record<string, unknown>;
        if (typeof action !== 'string' || !Object.hasOwn(schemas, action)) throw new Error('Unsupported procurement action.');
        const parsed = schemas[action].safeParse(fields);
        if (!parsed.success) throw new Error(`Invalid procurement input: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
        const { thought_process: _thought, ...args } = parsed.data;
        const operation = `${name.replace('procurement_', '')}.${action}`;
        const rpc = options.rpc ?? (async (op, input) => {
          const { dispatchProcurement } = await import('./transport');
          return dispatchProcurement(bound as { siteId: string; userId: string }, op, input);
        });
        let prepared = args;
        if (['requests.submit', 'tenders.publish', 'approvals.create'].includes(operation)) {
          const { prepareProcurementApproval } = await import('./policy');
          prepared = await prepareProcurementApproval(operation, args, rpc);
          // Fresh permission lookup immediately before the committing RPC.
          await assertToolScreenAccess(name, bound);
        }
        const data = await rpc(operation, prepared);
        return { success: true, operation, data };
      },
    };
  });
}