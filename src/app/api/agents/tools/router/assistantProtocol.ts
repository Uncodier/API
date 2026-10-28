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
 * Errors on `call` include the tool's `parameters` schema so the model can
 * auto-correct without needing a separate `describe` round-trip when it fails.
 */

import { EmbeddingsService } from '@/lib/services/embeddings-service';
import {
  assertToolScopeArgs, canUseToolScreen, guardToolScreen, loadToolScreenAccess,
  ToolScreenAccessDenied, ToolScreenAccessUnavailable, type ToolScreenAccess, type ToolScreenScope,
} from './screen-access';

export type RoutedTool = {
  name: string;
  description: string;
  parameters: Record<string, any>;
  execute: (args: any) => Promise<any> | any;
};

export type ToolCategory =
  | 'media'
  | 'messaging'
  | 'crm'
  | 'commerce'
  | 'social'
  | 'content'
  | 'infra'
  | 'research'
  | 'ui'
  | 'other';

// Category assignment is best-effort metadata for the `list` action so the
// model can filter/narrow (e.g. "show me all media tools"). Unknown names
// fall back to "other".
export const TOOL_CATEGORIES: Record<string, ToolCategory> = {
  // media
  generate_image: 'media',
  generate_video: 'media',
  generate_audio: 'media',
  audio_to_text: 'media',

  // messaging
  sendEmail: 'messaging',
  sendWhatsApp: 'messaging',
  whatsappTemplate: 'messaging',
  sendBulkMessages: 'messaging',
  placeVoiceCall: 'messaging',
  configure_email: 'messaging',
  configure_whatsapp: 'messaging',
  conversations: 'messaging',
  messages: 'messaging',

  // crm / growth
  leads: 'crm',
  sales: 'crm',
  deals: 'crm',
  sales_order: 'crm',
  quotations: 'commerce',
  quotation_items: 'commerce',
  entitlements: 'commerce',
  subscription_plan_items: 'commerce',
  subscriptions: 'commerce',
  price_lists: 'commerce',
  pass_redeemable_items: 'commerce',
  reservation_schedules: 'commerce',
  calendars: 'crm',
  reservations: 'commerce',
  catalog_commerce: 'commerce',
  promotions: 'commerce',
  checkout: 'commerce',
  purchases: 'commerce',
  purchase_items: 'commerce',
  transactions: 'commerce',
  audience: 'crm',
  segments: 'crm',
  campaigns: 'crm',
  analyzeICPTotalCount: 'crm',
  createIcpMining: 'crm',
  getFinderCategoryIds: 'crm',
  search_region_venues: 'crm',
  categories: 'content',

  // social
  social_media_accounts: 'social',
  social_media_publish: 'social',
  social_media_posts: 'social',
  social_media_analytics: 'social',
  publish: 'social',

  // content / assets
  content: 'content',
  copywriting: 'content',
  assets: 'content',
  site_settings: 'content',
  record_category: 'content',
  record: 'content',
  read_document: 'content',

  // infra / ops
  create_project: 'infra',
  create_secret: 'infra',
  webhooks: 'infra',
  workflows: 'infra',
  scheduling: 'infra',
  system_notification: 'infra',
  tasks: 'infra',
  report: 'infra',
  instance: 'infra',
  instance_project: 'infra',
  instance_logs: 'infra',
  instance_history: 'infra',
  update_repo: 'infra',
  createAccount: 'infra',
  verifyAccount: 'infra',
  memories: 'infra',
  save_on_memory: 'infra',
  get_memories: 'infra',

  // research
  webSearch: 'research',
  url_to_markdown: 'research',
  url_to_sitemap: 'research',

  // ui
  show_artifact: 'ui',
};

function categoryOf(name: string): ToolCategory {
  return TOOL_CATEGORIES[name] ?? 'other';
}

function shortDescription(desc: string | undefined, max = 180): string {
  if (!desc) return '';
  const firstLine = desc.split('\n')[0]!.trim();
  return firstLine.length > max ? firstLine.slice(0, max - 1).trimEnd() + '…' : firstLine;
}

function isValidationErrorMessage(msg: string | undefined): boolean {
  if (!msg) return false;
  const lower = msg.toLowerCase();
  // Server configuration and transport failures cannot be fixed by changing
  // tool arguments. Do not let words such as "invalid" trigger paid retries.
  if (/\bconfiguration\b|\brequest failed\s*\(5\d{2}\)|\brequest admission\b|\bgeneration outcome may be uncertain\b/.test(lower)) {
    return false;
  }
  return (
    lower.includes('invalid') ||
    lower.includes('required') ||
    lower.includes('missing') ||
    lower.includes('must be') ||
    lower.includes('expected') ||
    lower.includes('validation')
  );
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
  // Catalog-local cache: one user's filtered catalog must not poison another's
  // semantic search. Only permitted toolIndex entries are returned below.
  let cachedToolEmbeddings: Map<string, number[]> | null = null;
  let toolsEmbeddingsInitPromise: Promise<void> | null = null;
  const byName = new Map<string, RoutedTool>(routedTools.map((t) => [t.name, t]));

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
    '  4. action="call" with name=<tool_name> and args=<string> → executes the underlying tool and returns its result. If args are invalid the error payload includes the parameters schema so you can correct and retry.',
    '',
    'Use action="list" to see the categories and tools permitted for this user.',
    'Core planning/sandbox/requirement tools (instance_plan, requirement_status, requirements, sandbox_*, skill_lookup) are NOT routed here — they are always directly available.',
  ].join('\n');

  return {
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
    execute: async (args: { action: 'list' | 'search' | 'describe' | 'call'; name?: string; args?: any; category?: string; query?: string }) => {
      const { action } = args;
      const denied = () => screenAccessFailure(new ToolScreenAccessDenied(), true);
      const target = (action === 'describe' || action === 'call') && args.name ? byName.get(args.name) : undefined;
      // Unmapped tools cannot be allowed even for admins, regardless of DB health.
      if (target && !canUseToolScreen(target.name, { isAdmin: true, blockedScreens: [] })) return denied();
      let access: ToolScreenAccess | null;
      try {
        // A screen-independent target does not need a permission lookup.
        access = target && canUseToolScreen(target.name, null) ? null : await loadToolScreenAccess(scope);
      } catch (error) {
        if (error instanceof ToolScreenAccessUnavailable) {
          return screenAccessFailure(new ToolScreenAccessUnavailable(), true);
        }
        throw error;
      }
      const toolIndex = unfilteredToolIndex.filter(tool => canUseToolScreen(tool.name, access));
      const categoriesAvailable = Array.from(new Set(toolIndex.map(tool => tool.category))).sort();

      // `args.args` is declared as a JSON-encoded string (see schema note).
      // Accept both string (Gemini-friendly) and object (OpenAI/Azure direct
      // callers) so we don't break the existing surface.
      const parseCallArgs = (raw: any): { ok: true; value: any } | { ok: false; error: string } => {
        if (raw === undefined || raw === null) return { ok: true, value: {} };
        if (typeof raw === 'object') return { ok: true, value: raw };
        if (typeof raw !== 'string') {
          return { ok: false, error: `"args" must be a JSON-encoded object string, got ${typeof raw}.` };
        }
        const trimmed = raw.trim();
        if (!trimmed) return { ok: true, value: {} };
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return { ok: false, error: '"args" must decode to a JSON object (not array/null/primitive).' };
          }
          return { ok: true, value: parsed };
        } catch (e: any) {
          return { ok: false, error: `"args" is not valid JSON: ${e?.message || String(e)}` };
        }
      };

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
        const q = (args.query ?? '').trim();
        if (!q) {
          return { success: false, error: 'Missing "query" — provide a natural language description for the search.' };
        }

        try {
          if (!cachedToolEmbeddings) {
            if (!toolsEmbeddingsInitPromise) {
              toolsEmbeddingsInitPromise = (async () => {
                try {
                  if (unfilteredToolIndex.length === 0) {
                    cachedToolEmbeddings = new Map();
                    return;
                  }
                  const inputs = unfilteredToolIndex.map(
                    (t) => {
                      const fullTool = byName.get(t.name);
                      return `${t.name}\n${fullTool?.description || t.description}\n${t.category}`;
                    }
                  );
                  const { embeddings } = await EmbeddingsService.generateEmbeddings(inputs);
                  const map = new Map<string, number[]>();
                  for (let i = 0; i < unfilteredToolIndex.length; i++) {
                    if (embeddings[i]) {
                      map.set(unfilteredToolIndex[i].name, embeddings[i]);
                    }
                  }
                  cachedToolEmbeddings = map;
                  console.log(`[ToolsRouter] Cached vector embeddings for ${map.size} tools.`);
                } catch (e) {
                  console.error('[ToolsRouter] Failed to initialize tool embeddings:', e);
                  toolsEmbeddingsInitPromise = null;
                  throw e;
                }
              })();
            }
            await toolsEmbeddingsInitPromise;
          }

          const { embeddings: [queryEmbedding] } = await EmbeddingsService.generateEmbeddings(q);
          if (!queryEmbedding) {
            throw new Error('No embedding returned for query');
          }

          if (!cachedToolEmbeddings) {
            throw new Error('Tool embeddings not initialized properly');
          }

          const scored = toolIndex.map((tool) => {
            const toolVec = cachedToolEmbeddings!.get(tool.name);
            const score = toolVec ? EmbeddingsService.cosineSimilarity(queryEmbedding, toolVec) : 0;
            return { tool, score };
          });

          const matches = scored
            .filter((x) => x.score > 0.7)
            .sort((a, b) => b.score - a.score)
            .map((x) => {
              const fullTool = byName.get(x.tool.name);
              return {
                ...x.tool,
                description: fullTool?.description || x.tool.description,
                parameters: fullTool?.parameters,
              };
            })
            .slice(0, 10);

          return {
            success: true,
            query: q,
            count: matches.length,
            tools: matches,
            hint: matches.length > 0
              ? 'You can call action="call" directly with name+args using the parameters schema provided in the results.'
              : 'No matches found. Try a different query or use action="list" to see all tools.',
          };
        } catch (e: any) {
          console.warn('[ToolsRouter] Vector search failed, falling back to keyword search:', e);
          const lowerQ = q.toLowerCase();
          const words = lowerQ.split(/\s+/).filter(Boolean);
          const keywordMatches = toolIndex.filter(t => {
            const fullTool = byName.get(t.name);
            const hay = `${t.name} ${fullTool?.description || t.description} ${t.category}`.toLowerCase();
            return words.some(w => hay.includes(w));
          }).map(t => {
            const fullTool = byName.get(t.name);
            return {
              ...t,
              description: fullTool?.description || t.description,
              parameters: fullTool?.parameters,
            };
          }).slice(0, 10);
          
          return {
            success: true,
            query: q,
            count: keywordMatches.length,
            tools: keywordMatches,
            hint: keywordMatches.length > 0
              ? 'You can call action="call" directly with name+args using the parameters schema provided in the results.'
              : 'No matches found. Try a different query or use action="list" to see all tools.',
          };
        }
      }

      if (action === 'describe') {
        if (!args.name) {
          return { success: false, error: 'Missing "name" — provide the tool name to describe.' };
        }
        const tool = byName.get(args.name);
        if (tool && !canUseToolScreen(tool.name, access)) return denied();
        if (!tool) {
          return {
            success: false,
            error: `Tool "${args.name}" is not routed through tools. Call action="list" to see available tools.`,
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
        if (tool && !canUseToolScreen(tool.name, access)) return denied();
        if (!tool) {
          return {
            success: false,
            error: `Tool "${args.name}" is not routed through tools. Call action="list" to see available tools.`,
          };
        }
        const parsed = parseCallArgs(args.args);
        if (!parsed.ok) {
          return {
            success: false,
            name: tool.name,
            error: parsed.error,
            parameters: tool.parameters,
            hint: 'Re-send "args" as a JSON-encoded string of an object matching the parameters schema above.',
          };
        }
        const callArgs = parsed.value;
        try {
          assertToolScopeArgs(tool.name, callArgs, scope);
        } catch (error) {
          if (error instanceof ToolScreenAccessDenied) return denied();
          throw error;
        }
        try {
          const result = await tool.execute(callArgs);
          return {
            success: true,
            name: tool.name,
            result,
            ...hoistRoutedToolResult(result),
          };
        } catch (err: any) {
          // Fatal host failures must escape the router, not become retryable tool prose.
          if (err?.name === 'RecoveryError' || err?.name === 'OpenRouterBillingError') throw err;
          // Once dispatched, a permission code alone is not no-effect proof.
          if (err?.code === 'TOOL_SCREEN_ACCESS_DENIED') {
            return screenAccessFailure(new ToolScreenAccessDenied(), err?.effectStarted === false);
          }
          if (err?.code === 'TOOL_SCREEN_ACCESS_UNAVAILABLE') {
            return screenAccessFailure(new ToolScreenAccessUnavailable(), err?.effectStarted === false);
          }
          const message: string = err?.message || String(err);
          const includeSchema = isValidationErrorMessage(message);
          return {
            success: false,
            name: tool.name,
            error: message,
            ...(includeSchema
              ? {
                  parameters: tool.parameters,
                  hint: 'The error looks schema-related. Retry with args matching the parameters schema above.',
                }
              : {}),
          };
        }
      }

      return { success: false, error: `Unknown action "${(args as any).action}". Use "list", "describe", or "call".` };
    },
  };
}

function injectThoughtProcess(tool: RoutedTool): RoutedTool {
  if (!tool || !tool.parameters || !tool.parameters.properties) return tool;
  
  const currentRequired = tool.parameters.required || [];
  const newRequired = currentRequired.includes('thought_process') 
    ? currentRequired 
    : [...currentRequired, 'thought_process'];
    
  return {
    ...tool,
    parameters: {
      ...tool.parameters,
      properties: {
        ...tool.parameters.properties,
        thought_process: {
          type: 'string',
          description: 'Required. Explain step-by-step why you are calling this tool and what you expect to achieve based on your current objective.'
        }
      },
      required: newRequired
    }
  };
}

/**
 * Partition helper: given the full tools array and a set of always-on tool
 * names, returns `[...alwaysOn, tools(rest)]`.
 *
 * Use this from the orchestrator and from `inline-step-executor.ts` so both
 * code paths share the same routing policy.
 */
export function withToolsRouter(allTools: RoutedTool[], alwaysOnNames: ReadonlySet<string>, scope?: ToolScreenScope): RoutedTool[] {
  scope = scope ? { siteId: scope.siteId, userId: scope.userId } : undefined;
  const alwaysOn: RoutedTool[] = [];
  const routed: RoutedTool[] = [];
  
  const toolsWithThoughtProcess = allTools.map(injectThoughtProcess);
  
  for (const t of toolsWithThoughtProcess) {
    if (!t || typeof t.name !== 'string') continue;
    if (alwaysOnNames.has(t.name)) alwaysOn.push(guardToolScreen(t, scope));
    else routed.push(t);
  }
  if (routed.length === 0) return alwaysOn;
  
  const routerTool = injectThoughtProcess(toolsRouterTool(routed, scope) as RoutedTool);
  return [...alwaysOn, routerTool];
}

/**
 * Canonical always-on set (minimal).
 *
 * Shared by orchestrator and executors so behaviour is consistent.
 */
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

export const DEFAULT_ALWAYS_ON_TOOL_NAMES: ReadonlySet<string> = new Set([
  // Host-bound requirement capabilities share the same routing/permission guards.
  'read_files', 'list_files', 'search', 'apply_patch', 'exec', 'process_status', 'process_stop',
  'tracking_install', 'source_archive', 'deployment_trigger', 'deployment_status',
  'deployment_create', 'deployment_environment_sync', 'platform_key_provision',
  'capability_manifest', 'requirement_context', 'requirement_progress', 'requirement_plan',
  'finish_task', 'read_session_history', 'read_result_artifact', 'reconcile_operation',
  // sandbox surface — every agent uses these every turn
  'webSearch',
  'skill_lookup',
  'external_skill_lookup',
  'sandbox_run_command',
  'sandbox_read_file',
  'sandbox_list_files',
  'sandbox_write_file',
  'sandbox_push_checkpoint',
  'sandbox_restore_checkpoint',
  'sandbox_read_logs',
  // QA sandbox tools (names from getQaSandboxTools — we keep any whose name starts with sandbox_ or qa_)
  // They are added dynamically below via the isAlwaysOn() helper if needed.

  // plan + requirement surface — the contract between agents and the workflow
  'instance_plan',
  'requirement_status',
  'requirement_backlog',
  'requirements',
  'plan_result',
  'harness_inspect',
  'harness_events',
  'harness_reference',
  'harness_source',
  'harness_decide',
  
  // direct ui feedback surface
  'show_artifact',
]);

/**
 * More permissive check used by the partition helper: treats every tool whose
 * name starts with `sandbox_` or `qa_` as always-on, in addition to the
 * explicit set above. This future-proofs QA/sandbox tool additions without
 * having to update the constant each time.
 */
export function isAlwaysOnToolName(name: string): boolean {
  if (DEFAULT_ALWAYS_ON_TOOL_NAMES.has(name)) return true;
  if (name === 'webSearch') return true;
  if (name.startsWith('sandbox_')) return true;
  if (name.startsWith('qa_')) return true;
  return false;
}

/**
 * Convenience: same as `withToolsRouter` but uses the default always-on policy
 * (explicit set + the "sandbox_" and "qa_" name prefixes).
 */
export function routeTools(allTools: RoutedTool[], scope?: ToolScreenScope): RoutedTool[] {
  scope = scope ? { siteId: scope.siteId, userId: scope.userId } : undefined;
  const alwaysOn: RoutedTool[] = [];
  const routed: RoutedTool[] = [];
  
  // Inject thought_process into all tools to force the model to reason before acting
  const toolsWithThoughtProcess = allTools.map(injectThoughtProcess);

  for (const t of toolsWithThoughtProcess) {
    if (!t || typeof t.name !== 'string') continue;
    if (isAlwaysOnToolName(t.name)) alwaysOn.push(guardToolScreen(t, scope));
    else routed.push(t);
  }
  
  if (routed.length === 0) return alwaysOn;
  
  const routerTool = injectThoughtProcess(toolsRouterTool(routed, scope) as RoutedTool);
  return [...alwaysOn, routerTool];
}
