import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { inspectHarness } from './inspect';
import { readHarnessEvents, harnessEventsSchema } from './events';
import { decideHarness, harnessDecisionSchema } from './decisions';
import type { HarnessDiagnosticContext } from './context';
import { getHarnessReference } from './reference';
import { readHarnessSource, harnessSourceInputSchema } from './source';

const inspectSchema = z.object({ item_id: z.string().min(1).max(200).optional(), offset: z.number().int().min(0).max(10000).optional(), thought_process: z.string().max(2000).optional() }).strict();
const referenceSchema = z.object({ topic: z.string().max(100).optional(), thought_process: z.string().max(2000).optional() }).strict();
const sourceSchema = z.discriminatedUnion('action', [
  harnessSourceInputSchema.options[0].extend({ thought_process: z.string().max(2000).optional() }),
  harnessSourceInputSchema.options[1].extend({ thought_process: z.string().max(2000).optional() }),
]);
// Provider function schemas need an object at the root. Runtime Zod still enforces each action's exact fields.
const parameters = (schema: z.ZodTypeAny) => {
  const json = zodToJsonSchema(schema, { $refStrategy: 'none' }) as Record<string, any>;
  if (!json.anyOf) return json;
  const properties: Record<string, any> = {};
  for (const branch of json.anyOf) for (const [key, value] of Object.entries(branch.properties) as Array<[string, any]>) {
    if (value.const !== undefined) {
      const previous = properties[key]?.enum || [];
      properties[key] = { type: 'string', enum: Array.from(new Set([...previous, value.const])) };
    } else if (properties[key]?.maximum !== undefined && value.maximum !== undefined) {
      properties[key] = { ...value, maximum: Math.max(value.maximum, properties[key].maximum),
        description: `${key} maximum depends on the selected action: ${properties[key].maximum} or ${value.maximum}.` };
    } else properties[key] = value;
  }
  return { type: 'object', properties, additionalProperties: false,
    required: json.anyOf[0].required.filter((key: string) => json.anyOf.every((branch: any) => branch.required.includes(key))) };
};

const diagnosticContextKey = Symbol('harnessDiagnosticContext');
/** Call after routing/restriction so inspection never advertises a tool removed from this invocation. */
export function refreshHarnessToolManifest<T extends { name?: string }>(tools: T[], runtime?: string): T[] {
  for (const tool of tools) {
    const context = (tool as any)[diagnosticContextKey] as HarnessDiagnosticContext | undefined;
    if (!context) continue;
    context.toolNames = tools.map(entry => entry.name).filter((name): name is string => !!name);
    if (runtime) context.runtime = runtime;
  }
  return tools;
}

/** Direct diagnostic tools remain discoverable without routing or a sandbox. Scope is captured by the host. */
export function createHarnessDiagnosticTools(context: HarnessDiagnosticContext, options: { readOnly?: boolean } = {}) {
  // Static source/map contains no tenant data. Its host-bound tools remain usable during DB outages.
  const assertHostContext = () => {
    z.string().uuid().parse(context.siteId);
    z.string().uuid().parse(context.instanceId);
    if (context.requirementId) z.string().uuid().parse(context.requirementId);
  };
  const tools: Array<{ name: string; description: string; parameters: Record<string, any>; execute: (args: unknown) => Promise<any> }> = [
    { name: 'harness_inspect', description: 'Inspect authoritative requirement/backlog/plan/migration state, caller runtime and exposed tools. Read-only; works while product execution is blocked. Returns a state version for decisions, not a health guess.', parameters: parameters(inspectSchema),
      execute: async (args: unknown) => inspectHarness(context, inspectSchema.parse(args)) },
    { name: 'harness_events', description: 'List/read redacted events explicitly linked to this requirement across its instances. Trace who did what before a failure. Paginated; missing or unscoped logs are unknown, not proof of absence.', parameters: parameters(harnessEventsSchema),
      execute: async (args: unknown) => readHarnessEvents(context, args) },
    { name: 'harness_reference', description: 'Read the harness architecture map, state/tool semantics, recovery boundaries and decision options. Documentation is not a grant of authority.', parameters: parameters(referenceSchema),
      execute: async (raw: unknown) => { const args = referenceSchema.parse(raw); assertHostContext(); return getHarnessReference(args.topic); } },
    { name: 'harness_source', description: 'Search literal text or read allowlisted harness source with line references and revision provenance. This is host code, not the customer sandbox. Read-only; excludes secrets and unrelated repository files.', parameters: parameters(sourceSchema),
      execute: async (raw: unknown) => { const { thought_process: _, ...args } = sourceSchema.parse(raw); assertHostContext(); return readHarnessSource(args); } },
  ];
  if (!options.readOnly) tools.push({ name: 'harness_decide', description: 'Persist your evidence-backed decision: approve_backlog approves approach only; adapt_backlog changes implementation strategy, never acceptance/scope; escalate_support creates a technical ticket and attempts delivery to server-configured platform support. First inspect, cite event IDs, use the exact state version and keep request_id stable on replay. No SQL application, completion, unblocking or worker launch.',
    parameters: parameters(harnessDecisionSchema), execute: async (args: unknown) => decideHarness(context, args) });
  return tools.map(tool => Object.assign(tool, { [diagnosticContextKey]: context }));
}