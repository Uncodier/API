/**
 * `tools` — generic tool router (MCP-style)
 *
 * Mirrors the `skill_lookup` pattern but for tools. Instead of exposing 40+
 * tool schemas to the model (which floods the context and makes Gemini loop
 * on exploration), we expose a single `tools` and list/describe/call
 * the actual tools on demand.
 *
 * Flow:
 *   1. Model calls `tools({ action: "list" })`
 *      → gets [{ name, description (short), category }] for every routed tool.
 *   2. Model calls `tools({ action: "describe", name: "generate_image" })`
 *      → gets full description + parameters (JSON schema) + expected_use hint.
 *   3. Model calls `tools({ action: "call", name: "generate_image", args: {...} })`
 *      → we execute the underlying tool and return its result.
 *
 * Correct only proven preflight failures. After dispatch, exceptions cannot establish
 * whether the operation took effect. Authorized schema discovery is separate.
 */

import { findToolArgumentIssue, argumentFailure, type ToolArgumentIssue } from '@/lib/tools/argument-contract';
import { injectThoughtProcess, isAlwaysOnToolName, NATIVE_ARGUMENT_SCHEMA } from './tool-routing-policy';
export { DEFAULT_ALWAYS_ON_TOOL_NAMES, isAlwaysOnToolName } from './tool-routing-policy';

import { shareQueryVector, withSearchContext } from './search-context';
import { withConnectorResolver } from '@/lib/connectors/tool-resolver';
import { EmbeddingsService } from '@/lib/services/embeddings-service';
import { bindCatalogBatchActor } from '../catalog_commerce/batch-admin-tool';
import {
  assertToolScopeArgs, canUseToolScreen, guardToolScreen, isScreenGuardRejection, loadToolScreenAccess,
  ToolScreenAccessDenied, ToolScreenAccessUnavailable, type ToolScreenAccess, type ToolScreenScope,
} from './screen-access';

export type RoutedTool = {
  name: string;
  description: string;
  parameters: Record<string, any>;
  [NATIVE_ARGUMENT_SCHEMA]?: unknown;
  execute: (args: any, ...context: any[]) => Promise<any> | any;
};

import { categoryOf } from './tool-categories';
export { TOOL_CATEGORIES, type ToolCategory } from './tool-categories';

function shortDescription(desc: string | undefined, max = 180): string {
  if (!desc) return '';
  const firstLine = desc.split('\n')[0]!.trim();
  return firstLine.length > max ? firstLine.slice(0, max - 1).trimEnd() + '…' : firstLine;
}

const isObject = (input: unknown): input is Record<string, unknown> =>
  input !== null && typeof input === 'object' && !Array.isArray(input);

/** Null/empty/omitted direct arguments historically mean a no-argument call. */
function parseCallArgs(raw: unknown): Record<string, unknown> | null {
  if (raw == null || (typeof raw === 'string' && !raw.trim())) return {};
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); }
    catch { return null; }
  }
  return isObject(raw) ? raw : null;
}

/** Run after scope admission, against the effective native contract, not router decorations.
 * Some native tools accept both structured and string wire forms; leave those specific type
 * mismatches to the implementation. The caller's original arguments always reach the handler.
 */
function nativeArgumentIssue(tool: RoutedTool, args: unknown): ToolArgumentIssue | null {
  const schema = tool[NATIVE_ARGUMENT_SCHEMA] ?? tool.parameters;
  if (isObject(args) && Object.hasOwn(args, 'thought_process') && !tool.parameters?.properties?.thought_process) {
    const { thought_process: _metadata, ...input } = args;
    args = input;
  }
  return findToolArgumentIssue(schema, args, { allowNativeWireCompatibility: true });
}

/** Use only constant public errors here; never serialize the lookup failure. */
function screenAccessFailure(error: ToolScreenAccessDenied | ToolScreenAccessUnavailable, beforeDispatch: boolean) {
  return {
    success: false, code: error.code, status: error.status,
    ...(error instanceof ToolScreenAccessUnavailable ? { recoverable: error.recoverable } : {}),
    ...(beforeDispatch ? { executed: false } : {}),
    error: {
      code: error.code, message: error.message,
      ...(beforeDispatch ? { effectStarted: false } : {}),
    },
  };
}

/**
 * Builds the single `tools` tool that proxies to a set of routed tools.
 *
 * @param routedTools Array of tools (same `{name, description, parameters,
 *                    execute}` shape as every other assistant tool) that
 *                    should be hidden behind the router.
 */
export function toolsRouterTool(routedTools: RoutedTool[], scope?: ToolScreenScope) {
  scope = scope ? { siteId: scope.siteId, userId: scope.userId } : undefined;
  routedTools = routedTools.filter(tool => tool.name !== 'use_composio_tools' ||
    (tool as any)[Symbol.for('makinari.connector-gateway')] === true).map(tool => bindCatalogBatchActor(tool, scope));
  // Catalog-local cache: one user's filtered catalog must not poison another's
  // semantic search. Only permitted toolIndex entries are returned below.
  const nativeEmbeddings = new Map<string, Promise<{ model: string; vector: number[] }>>();
  const byName = new Map<string, RoutedTool>(routedTools.map((t) => [t.name, t]));
  const screenName = (name: string) => name === 'use_composio_tools' &&
    (byName.get(name) as any)?.[Symbol.for('makinari.connector-gateway')] === true ? 'connector_gateway' : name;

  const unfilteredToolIndex = routedTools.map((t) => ({
    name: t.name,
    description: shortDescription(t.description),
    category: categoryOf(t.name),
  }));

  const description = [
    'Discover and invoke specialized tools (media, messaging, CRM, commerce, social, content, infra, research, ui) without every schema being loaded upfront.',
    '',
    'USAGE (strict order):',
    '  1. action="list" [+ optional category filter] → returns [{ name, description, category }] for every routed tool.',
    '  2. action="search" with query="<your intent>" → returns the top tools matching your natural language query using semantic vector search. Includes parameters schema so you can call directly.',
    '  3. action="describe" with name=<tool_name> → returns the full description, parameters JSON schema, and expected_use hint. Use this if you only used action="list".',
    '  4. action="call" with name=<tool_name> and args=<string> → executes the underlying tool and returns its result. A preflight error identifies an argument to correct. If the outcome is uncertain, verify it before any new call.',
    '',
    'Use action="list" to see the categories and tools permitted for this user.',
    'Core planning/sandbox/requirement tools (instance_plan, requirement_status, requirements, sandbox_*, skill_lookup) are NOT routed here — they are always directly available.',
  ].join('\n');

  const nativeRouter = {
    name: 'tools',
    description,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'search', 'describe', 'call'],
          description: 'What to do. Use "list" or "search" first to discover tools, "describe" to inspect a specific tool, "call" to execute it.',
        },
        name: {
          type: 'string',
          description: 'Tool name (required for "describe" and "call").',
        },
        query: {
          type: 'string',
          description: 'Natural language query (required for "search"). Describe what you want to achieve.',
        },
        // NOTE: Typed as a JSON-encoded string instead of `type: "object"`.
        // Reason: Gemini's OpenAI-compat function declarations reject objects
        // without explicit `properties` and reject `additionalProperties: true`,
        // which is incompatible with a generic "pass anything" router argument.
        // Other MCP-style routers solve this the same way. We JSON.parse it in
        // `execute()` (with a fallback to a raw object for OpenAI/Azure callers
        // that may still pass an inline object).
        args: {
          type: 'string',
          description:
            'JSON-encoded object with the arguments to pass to the underlying tool (required for "call"). Example: "{\\"prompt\\":\\"hello\\"}". Use "describe" first if unsure of the schema.',
        },
        category: {
          type: 'string',
          description: 'Optional. Filter the "list" action by category (e.g. "media", "messaging", "crm", "commerce", "social", "content", "infra", "research", "ui").',
        },
      },
      required: ['action'],
    },
    execute: async (args: { action: 'list' | 'search' | 'describe' | 'call'; name?: string; args?: any; category?: string; query?: string;
      domain?: string; connector_id?: string; connector_cursor?: string; catalog_query?: string }) => {
      const { action } = args;
      const denied = () => screenAccessFailure(new ToolScreenAccessDenied(), true);
      const target = (action === 'describe' || action === 'call') && args.name ? byName.get(args.name) : undefined;
      // Unmapped tools cannot be allowed even for admins, regardless of DB health.
      if (target && !canUseToolScreen(screenName(target.name), { isAdmin: true, blockedScreens: [] })) return denied();
      let access: ToolScreenAccess | null;
      try {
        // A screen-independent target does not need a permission lookup.
        access = target && canUseToolScreen(screenName(target.name), null) ? null : await loadToolScreenAccess(scope);
      } catch (error) {
        if (error instanceof ToolScreenAccessUnavailable) {
          return screenAccessFailure(new ToolScreenAccessUnavailable(), true);
        }
        throw error;
      }
      const toolIndex = unfilteredToolIndex.filter(tool => canUseToolScreen(screenName(tool.name), access));
      const categoriesAvailable = Array.from(new Set(toolIndex.map(tool => tool.category))).sort();

      if (action === 'list') {
        const filtered = args.category
          ? toolIndex.filter((t) => t.category === args.category)
          : toolIndex;
        return {
          success: true,
          count: filtered.length,
          tools: filtered,
          categories: categoriesAvailable,
          hint: 'Call action="describe" with a name to get the parameters schema, then action="call" with name+args to execute.',
        };
      }

      if (action === 'search') {
        const q = typeof args.query === 'string' ? args.query.trim() : '';
        if (!q) {
          return { success: false, error: 'Missing "query" — provide a natural language description for the search.' };
        }

        const words = [...new Set(q.toLowerCase().split(/\s+/).filter(w => w.length > 2))];
        const eligible = args.category ? toolIndex.filter(t => t.category === args.category) : toolIndex;
        const scores = eligible.map(tool => {
          const text = `${tool.name} ${byName.get(tool.name)?.description || tool.description} ${tool.category}`.toLowerCase();
          const keywords = words.filter(word => text.includes(word)).length;
          return (tool.name.toLowerCase() === q.toLowerCase() ? 10 : 0) + keywords / Math.max(words.length, 1);
        });
        try {
          // Host-decorated descriptions may contain tenant context. Only
          // screen-mapped names and static categories belong in the index.
          const missing = [...new Map(eligible.filter(t => !nativeEmbeddings.has(t.name)).map(t => [t.name, t])).values()];
          if (missing.length) {
            const batch = EmbeddingsService.generateEmbeddings(missing.map(t => `${t.name}\n${t.category}`));
            missing.forEach((t, i) => nativeEmbeddings.set(t.name, batch.then(result => ({ model: result.model, vector: result.embeddings[i] })).catch(error => {
              nativeEmbeddings.delete(t.name);
              throw error;
            })));
          }
          const vectors = await Promise.all(eligible.map(t => nativeEmbeddings.get(t.name)));
          const { model, embeddings: [queryEmbedding] } = await EmbeddingsService.generateEmbeddings(q);
          if (!queryEmbedding) throw new Error('Missing query embedding');
          shareQueryVector(q, { model, vector: queryEmbedding });
          vectors.forEach((doc, i) => {
            if (!doc || doc.model !== model || doc.vector?.length !== queryEmbedding.length) return;
            const score = EmbeddingsService.cosineSimilarity(queryEmbedding, doc.vector);
            if (score > 0.7) scores[i] += score;
          });
        } catch {
          console.warn('[ToolsRouter] Vector search unavailable; using keyword search.');
        }
        const matches = eligible.map((tool, i) => ({ tool, score: scores[i] })).filter(x => x.score > 0)
          .sort((a, b) => b.score - a.score).slice(0, 10).map(({ tool }) => {
            const fullTool = byName.get(tool.name);
            return { ...tool, description: fullTool?.description || tool.description, parameters: fullTool?.parameters };
          });
        return { success: true, query: q, count: matches.length, tools: matches,
          hint: matches.length ? 'Use action="call" with name and arguments matching the returned schema.'
            : 'No matches found. Try another query or use action="list".' };

      }

      if (action === 'describe') {
        if (!args.name) {
          return { success: false, error: 'Missing "name" — provide the tool name to describe.' };
        }
        const tool = byName.get(args.name);
        if (tool && !canUseToolScreen(screenName(tool.name), access)) return denied();
        if (!tool) {
          return {
            success: false,
            error: 'This tool is not routed through tools. Call action="list" to see available tools.',
          };
        }
        return {
          success: true,
          name: tool.name,
          category: categoryOf(tool.name),
          description: tool.description,
          parameters: tool.parameters,
          expected_use:
            'Pass the returned "parameters" schema when calling `tools action="call" name="' +
            tool.name +
            '" args={...}`. Required fields are listed in parameters.required (if any).',
        };
      }

      if (action === 'call') {
        if (!args.name) {
          return { success: false, error: 'Missing "name" — provide the tool name to call.' };
        }
        const tool = byName.get(args.name);
        if (tool && !canUseToolScreen(screenName(tool.name), access)) return denied();
        if (!tool) {
          return {
            success: false,
            error: 'This tool is not routed through tools. Call action="list" to see available tools.',
          };
        }
        const callArgs = parseCallArgs(args.args);
        if (callArgs === null) return { name: tool.name, ...argumentFailure({ path: 'arguments', rule: 'json_object' }) };
        try {
          assertToolScopeArgs(tool.name, callArgs, scope);
        } catch (error) {
          if (error instanceof ToolScreenAccessDenied) return denied();
          throw error;
        }
        // The compatibility gateway admits the connector action and its input under its own grant.
        const issue = screenName(tool.name) === 'connector_gateway' ? null : nativeArgumentIssue(tool, callArgs);
        if (issue) return { name: tool.name, ...argumentFailure(issue) };
        try {
          const result = await tool.execute(callArgs);
          return {
            success: result?.success !== false,
            name: tool.name,
            result,
            ...hoistRoutedToolResult(result),
          };
        } catch (err: any) {
          // Fatal host failures must escape the router, not become retryable tool prose.
          if (err?.name === 'RecoveryError' || err?.name === 'OpenRouterBillingError') throw err;
          // Once dispatched, a permission code alone is not no-effect proof.
          if (err?.code === 'TOOL_SCREEN_ACCESS_DENIED') {
            return screenAccessFailure(new ToolScreenAccessDenied(), isScreenGuardRejection(err));
          }
          if (err?.code === 'TOOL_SCREEN_ACCESS_UNAVAILABLE') {
            return screenAccessFailure(new ToolScreenAccessUnavailable(), isScreenGuardRejection(err));
          }
          return {
            success: false, name: tool.name, code: 'TOOL_OUTCOME_UNKNOWN', automatic_retry: false,
            error: 'Tool execution did not return a confirmed outcome.',
            recovery: { action: 'reconcile', message: 'Verify the outcome in the original system before taking further action. Do not repeat the call automatically.' },
          };
        }
      }

      return { success: false, error: 'Unknown action. Use "list", "search", "describe", or "call".' };
    },
  };
  // The facade lazily loads provider/runtime code only after a real host binding.
  if (!routedTools.some(tool => (tool as any)[Symbol.for('makinari.connector-gateway')] === true)) return nativeRouter;
  const resolved = withConnectorResolver(nativeRouter, routedTools, scope);
  return { ...resolved, execute: (args: Parameters<typeof nativeRouter.execute>[0]) => {
    const run = async () => resolved.execute(args);
    return args.action === 'search' && typeof args.query === 'string' ? withSearchContext(args.query, run) : run();
  } };

}

/**
 * Partition helper: given the full tools array and a set of always-on tool
 * names, returns `[...alwaysOn, tools(rest)]`.
 *
 * Use this from the orchestrator and from `inline-step-executor.ts` so both
 * code paths share the same routing policy.
 */
export function withToolsRouter(allTools: RoutedTool[], alwaysOnNames: ReadonlySet<string>, scope?: ToolScreenScope): RoutedTool[] {
  return partitionTools(allTools, name => alwaysOnNames.has(name), scope);
}

function partitionTools(allTools: RoutedTool[], alwaysOn: (name: string) => boolean, scope?: ToolScreenScope): RoutedTool[] {
  scope = scope ? { siteId: scope.siteId, userId: scope.userId } : undefined;
  const direct: RoutedTool[] = [];
  const routed: RoutedTool[] = [];
  for (const tool of allTools) {
    if (!tool || typeof tool.name !== 'string') continue;
    if (alwaysOn(tool.name)) {
      // The screen/scope guard is outermost. Do not catch dispatch here: host-owned
      // results, context arguments, and control-flow exceptions keep their direct contract.
      const guarded = guardToolScreen({ ...tool, execute: (args: unknown, ...context: unknown[]) => {
        const issue = nativeArgumentIssue(tool, args);
        if (issue) return argumentFailure(issue);
        return tool.execute(args, ...context);
      } }, scope);
      direct.push(injectThoughtProcess(guarded));
    } else {
      // The outer `tools` already carries transport metadata; do not impose it on inner calls.
      routed.push(tool);
    }
  }
  if (routed.length) direct.push(injectThoughtProcess(toolsRouterTool(routed, scope)));
  return direct;
}

/** Hoist webSearch-style `{ results, answer }` so `tools` does not return only the search answer. */
export function hoistRoutedToolResult(result: unknown): { results?: unknown; answer?: unknown; citations?: unknown; sources?: unknown } {
  if (!result || typeof result !== 'object') return {};
  const outer = result as { results?: unknown; answer?: unknown; result?: unknown; citations?: unknown; sources?: unknown };
  if (Array.isArray(outer.results)) {
    return {
      results: outer.results, answer: outer.answer,
      ...(Array.isArray(outer.citations) ? { citations: outer.citations } : {}),
      ...(Array.isArray(outer.sources) ? { sources: outer.sources } : {}),
    };
  }
  const inner = outer.result;
  if (inner && typeof inner === 'object') {
    const nested = inner as { results?: unknown; answer?: unknown; citations?: unknown; sources?: unknown };
    if (Array.isArray(nested.results)) {
      return {
        results: nested.results, answer: nested.answer,
        ...(Array.isArray(nested.citations) ? { citations: nested.citations } : {}),
        ...(Array.isArray(nested.sources) ? { sources: nested.sources } : {}),
      };
    }
  }
  return {};
}

/**
 * Convenience: same as `withToolsRouter` but uses the default always-on policy
 * (explicit set + the "sandbox_" and "qa_" name prefixes).
 */
export function routeTools(allTools: RoutedTool[], scope?: ToolScreenScope): RoutedTool[] {
  return partitionTools(allTools, isAlwaysOnToolName, scope);
}
