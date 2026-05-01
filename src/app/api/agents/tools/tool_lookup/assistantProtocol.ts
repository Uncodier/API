/**
 * `tool_lookup` — generic tool router (MCP-style)
 *
 * Mirrors the `skill_lookup` pattern but for tools. Instead of exposing 40+
 * tool schemas to the model (which floods the context and makes Gemini loop
 * on exploration), we expose a single `tool_lookup` and list/describe/call
 * the actual tools on demand.
 *
 * Flow:
 *   1. Model calls `tool_lookup({ action: "list" })`
 *      → gets [{ name, description (short), category }] for every routed tool.
 *   2. Model calls `tool_lookup({ action: "describe", name: "generate_image" })`
 *      → gets full description + parameters (JSON schema) + expected_use hint.
 *   3. Model calls `tool_lookup({ action: "call", name: "generate_image", args: {...} })`
 *      → we execute the underlying tool and return its result.
 *
 * Errors on `call` include the tool's `parameters` schema so the model can
 * auto-correct without needing a separate `describe` round-trip when it fails.
 */

export type RoutedTool = {
  name: string;
  description: string;
  parameters: Record<string, any>;
  execute: (args: any) => Promise<any> | any;
};

export type ToolLookupCategory =
  | 'media'
  | 'messaging'
  | 'crm'
  | 'social'
  | 'content'
  | 'infra'
  | 'research'
  | 'other';

// Category assignment is best-effort metadata for the `list` action so the
// model can filter/narrow (e.g. "show me all media tools"). Unknown names
// fall back to "other".
const TOOL_CATEGORIES: Record<string, ToolLookupCategory> = {
  // media
  generateImage: 'media',
  generateVideo: 'media',
  generateAudio: 'media',
  audioToText: 'media',

  // messaging
  sendEmail: 'messaging',
  sendWhatsApp: 'messaging',
  whatsappTemplate: 'messaging',
  sendBulkMessages: 'messaging',
  configureEmail: 'messaging',
  configureWhatsApp: 'messaging',
  conversations: 'messaging',
  messages: 'messaging',

  // crm / growth
  leads: 'crm',
  sales: 'crm',
  deals: 'crm',
  salesOrder: 'crm',
  audience: 'crm',
  segments: 'crm',
  campaigns: 'crm',
  analyzeICPTotalCount: 'crm',
  createIcpMining: 'crm',
  getFinderCategoryIds: 'crm',
  searchRegionVenues: 'crm',

  // social
  socialMediaAccounts: 'social',
  socialMediaPublish: 'social',
  socialMediaPosts: 'social',
  publish: 'social',

  // content / assets
  content: 'content',
  copywriting: 'content',
  assets: 'content',
  updateSiteSettings: 'content',

  // infra / ops
  createProject: 'infra',
  createSecret: 'infra',
  webhooks: 'infra',
  workflows: 'infra',
  scheduling: 'infra',
  systemNotification: 'infra',
  tasks: 'infra',
  report: 'infra',
  instance: 'infra',
  instance_project: 'infra',
  instance_logs: 'infra',
  createAccount: 'infra',
  verifyAccount: 'infra',
  memories: 'infra',

  // research
  webSearch: 'research',
  url_to_markdown: 'research',
  urlToSitemap: 'research',
};

function categoryOf(name: string): ToolLookupCategory {
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
  return (
    lower.includes('invalid') ||
    lower.includes('required') ||
    lower.includes('missing') ||
    lower.includes('must be') ||
    lower.includes('expected') ||
    lower.includes('validation')
  );
}

/**
 * Builds the single `tool_lookup` tool that proxies to a set of routed tools.
 *
 * @param routedTools Array of tools (same `{name, description, parameters,
 *                    execute}` shape as every other assistant tool) that
 *                    should be hidden behind the router.
 */
export function toolLookupTool(routedTools: RoutedTool[]) {
  const byName = new Map<string, RoutedTool>(routedTools.map((t) => [t.name, t]));

  const toolIndex = routedTools.map((t) => ({
    name: t.name,
    description: shortDescription(t.description),
    category: categoryOf(t.name),
  }));

  const categoriesAvailable = Array.from(new Set(toolIndex.map((t) => t.category))).sort();

  const description = [
    'Discover and invoke specialized tools (media, messaging, CRM, social, content, infra, research) without every schema being loaded upfront.',
    '',
    'USAGE (strict order):',
    '  1. action="list" [+ optional category filter] → returns [{ name, description, category }] for every routed tool.',
    '  2. action="describe" with name=<tool_name> → returns the full description, parameters JSON schema, and expected_use hint.',
    '  3. action="call" with name=<tool_name> and args=<object> → executes the underlying tool and returns its result. If args are invalid the error payload includes the parameters schema so you can correct and retry.',
    '',
    `Categories available: ${categoriesAvailable.join(', ')}.`,
    'Core planning/sandbox/requirement tools (instance_plan, requirement_status, requirements, sandbox_*, skill_lookup) are NOT routed here — they are always directly available.',
  ].join('\n');

  return {
    name: 'tool_lookup',
    description,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'describe', 'call'],
          description: 'What to do. Use "list" first to discover tools, "describe" to inspect a specific tool, "call" to execute it.',
        },
        name: {
          type: 'string',
          description: 'Tool name (required for "describe" and "call").',
        },
        // NOTE: Typed as a JSON-encoded string instead of `type: "object"`.
        // Reason: Gemini's OpenAI-compat function declarations reject objects
        // without explicit `properties` and reject `additionalProperties: true`,
        // which is incompatible with a generic "pass anything" router argument.
        // Other MCP-style routers solve this the same way. We JSON.parse it in
        // `execute()` (with a fallback to a raw object for OpenAI/Azure callers
        // that may still pass an inline object).
        args: {
          type: 'object',
          additionalProperties: true,
          description:
            'Object with the arguments to pass to the underlying tool (required for "call"). Use "describe" first if unsure of the schema.',
        },
        category: {
          type: 'string',
          description: 'Optional. Filter the "list" action by category (e.g. "media", "messaging", "crm", "social", "content", "infra", "research").',
        },
      },
      required: ['action'],
    },
    execute: async (args: { action: 'list' | 'describe' | 'call'; name?: string; args?: any; category?: string }) => {
      const { action } = args;

      // `args.args` is declared as a JSON-encoded string (see schema note).
      // Accept both string (Gemini-friendly) and object (OpenAI/Azure direct
      // callers) so we don't break the existing surface.
      const parseCallArgs = (raw: any): { ok: true; value: any } | { ok: false; error: string } => {
        if (raw === undefined || raw === null) return { ok: true, value: {} };
        if (typeof raw === 'string') {
           try {
             const parsed = JSON.parse(raw);
             return { ok: true, value: typeof parsed === 'object' && parsed !== null ? parsed : {} };
           } catch {
             return { ok: false, error: 'If args is a string, it must be valid JSON.' };
           }
        }
        if (typeof raw === 'object' && !Array.isArray(raw)) {
          return { ok: true, value: raw };
        }
        return { ok: false, error: '"args" must be an object.' };
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

      if (action === 'describe') {
        if (!args.name) {
          return { success: false, error: 'Missing "name" — provide the tool name to describe.' };
        }
        const tool = byName.get(args.name);
        if (!tool) {
          return {
            success: false,
            error: `Tool "${args.name}" is not routed through tool_lookup. Call action="list" to see available tools.`,
          };
        }
        return {
          success: true,
          name: tool.name,
          category: categoryOf(tool.name),
          description: tool.description,
          parameters: tool.parameters,
          expected_use:
            'Pass the returned "parameters" schema when calling `tool_lookup action="call" name="' +
            tool.name +
            '" args={...}`. Required fields are listed in parameters.required (if any).',
        };
      }

      if (action === 'call') {
        if (!args.name) {
          return { success: false, error: 'Missing "name" — provide the tool name to call.' };
        }
        const tool = byName.get(args.name);
        if (!tool) {
          return {
            success: false,
            error: `Tool "${args.name}" is not routed through tool_lookup. Call action="list" to see available tools.`,
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
          const result = await tool.execute(callArgs);
          return {
            success: true,
            name: tool.name,
            result,
          };
        } catch (err: any) {
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
 * names, returns `[...alwaysOn, tool_lookup(rest)]`.
 *
 * Use this from the orchestrator and from `inline-step-executor.ts` so both
 * code paths share the same routing policy.
 */
export function withToolLookup(allTools: RoutedTool[], alwaysOnNames: ReadonlySet<string>): RoutedTool[] {
  const alwaysOn: RoutedTool[] = [];
  const routed: RoutedTool[] = [];
  
  const toolsWithThoughtProcess = allTools.map(injectThoughtProcess);
  
  for (const t of toolsWithThoughtProcess) {
    if (!t || typeof t.name !== 'string') continue;
    if (alwaysOnNames.has(t.name)) alwaysOn.push(t);
    else routed.push(t);
  }
  if (routed.length === 0) return alwaysOn;
  
  const lookupTool = injectThoughtProcess(toolLookupTool(routed) as RoutedTool);
  return [...alwaysOn, lookupTool];
}

/**
 * Canonical always-on set (minimal).
 *
 * Shared by orchestrator and executors so behaviour is consistent.
 */
export const DEFAULT_ALWAYS_ON_TOOL_NAMES: ReadonlySet<string> = new Set([
  // sandbox surface — every agent uses these every turn
  'skill_lookup',
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
]);

/**
 * More permissive check used by the partition helper: treats every tool whose
 * name starts with `sandbox_` or `qa_` as always-on, in addition to the
 * explicit set above. This future-proofs QA/sandbox tool additions without
 * having to update the constant each time.
 */
export function isAlwaysOnToolName(name: string): boolean {
  if (DEFAULT_ALWAYS_ON_TOOL_NAMES.has(name)) return true;
  if (name.startsWith('sandbox_')) return true;
  if (name.startsWith('qa_')) return true;
  return false;
}

/**
 * Convenience: same as `withToolLookup` but uses the default always-on policy
 * (explicit set + the "sandbox_" and "qa_" name prefixes).
 */
export function routeTools(allTools: RoutedTool[]): RoutedTool[] {
  const alwaysOn: RoutedTool[] = [];
  const routed: RoutedTool[] = [];
  
  // Inject thought_process into all tools to force the model to reason before acting
  const toolsWithThoughtProcess = allTools.map(injectThoughtProcess);

  for (const t of toolsWithThoughtProcess) {
    if (!t || typeof t.name !== 'string') continue;
    if (isAlwaysOnToolName(t.name)) alwaysOn.push(t);
    else routed.push(t);
  }
  
  if (routed.length === 0) return alwaysOn;
  
  const lookupTool = injectThoughtProcess(toolLookupTool(routed) as RoutedTool);
  return [...alwaysOn, lookupTool];
}
