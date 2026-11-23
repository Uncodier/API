import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { resolveChatOutputTokens } from '@/lib/services/ai/openrouter-chat-request';
import { fitInstanceRequest, resolveModelContextCapacity } from '@/lib/services/robot-instance/instance-context-budget';
import { observedToolName } from '@/lib/connectors/connector-observation';
import { sanitizeMessagesForAzureVisionImages } from '../azure-vision-message-sanitize';
import { sanitizeMessagesForGemini } from '../gemini-message-sanitize';
import type { ActOptions, AIProvider, Message, Tool } from './types';
import { filterImages, MAX_SCREENSHOT_HISTORY } from './vision';

/**
 * Convert Zod schema to JSON Schema for structured outputs.
 */
function structuredOutputSchema(schema: z.ZodType<any>): Record<string, any> {
  const convert = (s: any): any => {
    if (s instanceof z.ZodObject) {
      const shape = s.shape;
      const properties: Record<string, any> = {};
      const required: string[] = [];

      for (const [key, value] of Object.entries(shape)) {
        properties[key] = convert(value);
        if (!(value as any).isOptional()) {
          required.push(key);
        }
      }

      return {
        type: 'object',
        properties,
        required,
        additionalProperties: false,
      };
    }

    if (s instanceof z.ZodString) {
      return { type: 'string' };
    }

    if (s instanceof z.ZodNumber) {
      return { type: 'number' };
    }

    if (s instanceof z.ZodBoolean) {
      return { type: 'boolean' };
    }

    if (s instanceof z.ZodArray) {
      return {
        type: 'array',
        items: convert(s.element),
      };
    }

    if (s instanceof z.ZodEnum) {
      return {
        type: 'string',
        enum: s.options,
      };
    }

    if (s instanceof z.ZodOptional) {
      return convert(s.unwrap());
    }

    if (s instanceof z.ZodNullable) {
      const inner = convert(s.unwrap());
      return {
        ...inner,
        nullable: true,
      };
    }

    return { type: 'string' };
  };

  return convert(schema);
}

export function prepareConversation({ tools, system, prompt, messages: initialMessages }: ActOptions) {
  const uniqueTools: Tool[] = [];
  const seenToolNames = new Set<string>();
  for (const tool of tools) {
    if (!seenToolNames.has(tool.name)) {
      uniqueTools.push(tool);
      seenToolNames.add(tool.name);
    }
  }
  const finalTools = uniqueTools;

  console.log(`₍ᐢ•(ܫ)•ᐢ₎ [EXECUTOR] Initializing with ${finalTools.length} tool(s):`);
  finalTools.forEach((tool, index) => {
    console.log(`  ${index + 1}. ${observedToolName(tool.name)}`);
    if (tool.parameters) {
      const isZodSchema = typeof tool.parameters === 'object' && '_def' in tool.parameters;
      console.log(`     Parameters: ${isZodSchema ? 'Zod Schema' : 'JSON Schema'}`);
    }
  });

  const messages: Message[] = [];

  if (system) {
    messages.push({ role: 'system', content: system });
  }

  if (initialMessages) {
    // When `system` is explicit, drop any system messages already present
    // in `initialMessages`. This is the typical re-entry case: the caller
    // passes back our previous return value (which always begins with the
    // system message we prepended). Without this filter, every additional
    // turn adds another system entry, producing histories like
    // [system_new, system_old, user, assistant, tool]. Gemini's
    // OpenAI-compat layer 400s (no body) on multi-system histories, and
    // Azure/OpenAI just waste tokens on the duplicate prompt.
    const sanitizedInitial = system
      ? initialMessages.filter((m: any) => m?.role !== 'system')
      : initialMessages;
    const droppedSystems = initialMessages.length - sanitizedInitial.length;
    if (droppedSystems > 0) {
      console.log(
        `₍ᐢ•(ܫ)•ᐢ₎ [EXECUTOR] Dropped ${droppedSystems} duplicate system message(s) from initialMessages (using explicit system param)`,
      );
    }
    messages.push(...sanitizedInitial);
  } else if (prompt) {
    messages.push({ role: 'user', content: prompt });
  }

  const openaiTools = finalTools.map(tool => {
    let parameters: Record<string, any>;

    if (tool.parameters && typeof tool.parameters === 'object' && '_def' in tool.parameters) {
      parameters = zodToJsonSchema(tool.parameters as z.ZodType<any>, {
        target: 'openApi3',
        $refStrategy: 'none',
      }) as Record<string, any>;
    } else {
      parameters = tool.parameters as Record<string, any> || { type: 'object', properties: { _dummy: { type: 'string', description: 'Not used' } } };
    }

    // 🚨 CRITICAL FIX FOR GEMINI 🚨
    // Gemini API strictly rejects tool schemas where type is 'object' but properties is empty {}.
    // If we find an empty properties object, we MUST inject a dummy property.
    if (parameters && parameters.type === 'object') {
      if (!parameters.properties || Object.keys(parameters.properties).length === 0) {
        parameters.properties = { _dummy: { type: 'string', description: 'Not used' } };
      }
    }

    return {
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description || `Tool: ${tool.name}`,
        parameters,
      },
    };
  });
  return { finalTools, messages, openaiTools };
}

export async function prepareIterationRequest(options: ActOptions, provider: AIProvider, modelName: string, isReasoningModel: boolean,
  capacityModel: string, siteId: string | undefined, messages: Message[],
  openaiTools: ReturnType<typeof prepareConversation>['openaiTools'], iterations: number) {
  const { schema, system, enforceSingleTurn = false, temperature = 1, reasoningEffort = 'low', verbosity = 'low',
    enforceContextBudget, onContextUsage, executionBoundary } = options;
  const imagesBefore = messages.filter((m: any) =>
    m.role === 'user' && Array.isArray(m.content) &&
    m.content.some((c: any) => c.type === 'image_url')
  ).length;

  filterImages(messages, MAX_SCREENSHOT_HISTORY);

  const imagesAfter = messages.filter((m: any) =>
    m.role === 'user' && Array.isArray(m.content) &&
    m.content.some((c: any) => c.type === 'image_url')
  ).length;

  if (imagesBefore > imagesAfter) {
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ [IMAGE_FILTER] Reduced image-bearing messages by ${imagesBefore - imagesAfter}; explicit references take priority over recency`);
  }

  // Gemini's OpenAI-compat layer 400s (no body) when assistant turns
  // carry `content: null` together with `tool_calls`, or when tool
  // messages still include the deprecated `name` field. Normalize both
  // before every call so retries and the streaming/non-streaming
  // fallback paths share a clean history.
  if (provider === 'gemini') {
    const {
      assistantContentCoerced,
      toolContentCoerced,
      toolNameStripped,
      assistantExtrasStripped,
      toolCallExtrasStripped,
      imagePartsStripped,
      systemMessagesDeduped,
      thoughtSignatureSentinelsInjected,
    } = sanitizeMessagesForGemini(messages);
    if (
      assistantContentCoerced > 0 ||
      toolContentCoerced > 0 ||
      toolNameStripped > 0 ||
      assistantExtrasStripped > 0 ||
      toolCallExtrasStripped > 0 ||
      imagePartsStripped > 0 ||
      systemMessagesDeduped > 0 ||
      thoughtSignatureSentinelsInjected > 0
    ) {
      console.warn(
        `₍ᐢ•(ܫ)•ᐢ₎ [GEMINI_SANITIZE] coerced ${assistantContentCoerced} assistant content(s) + ${toolContentCoerced} tool content(s) to "", stripped ${toolNameStripped} tool name field(s), ${assistantExtrasStripped} assistant extra field(s), ${toolCallExtrasStripped} tool_call extra field(s), ${imagePartsStripped} malformed image part(s), deduped ${systemMessagesDeduped} extra system message(s), injected ${thoughtSignatureSentinelsInjected} thought_signature sentinel(s)`,
      );
    }
  }

  // Azure vision sanitization only applies to Azure. Other providers (Gemini, OpenAI)
  // accept the same data URLs that Azure rejects.
  if (provider === 'azure') {
    const visionStripped = sanitizeMessagesForAzureVisionImages(messages);
    if (visionStripped > 0) {
      console.warn(
        `₍ᐢ•(ܫ)•ᐢ₎ [AZURE_VISION] Removed ${visionStripped} unsupported or invalid image part(s) before API call`
      );
    }
  }

  const completionOptions: any = {
    model: modelName,
    messages,
    max_tokens: resolveChatOutputTokens(options.maxOutputTokens, enforceSingleTurn),
    ...(siteId ? { user: siteId } : {}),
  };

  // After enough iterations with a schema, drop tools to force JSON output.
  const shouldForceJson = schema && iterations > 15;

  if (!shouldForceJson && openaiTools.length > 0) {
    completionOptions.tools = openaiTools;
    // The selected GPT-6 model does not advertise parallel_tool_calls.
    // Local single-turn execution remains authoritative for all models.
    if (enforceSingleTurn && !isReasoningModel) {
      completionOptions.parallel_tool_calls = false;
    }
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ [EXECUTOR] Including tools in API call`);
  } else if (shouldForceJson) {
    console.log(`⚠️ [EXECUTOR] Forcing JSON output - removing tools (iteration ${iterations})`);
  }

  // Temperature: Azure reasoning models reject non-default values; Gemini accepts it.
  if (!isReasoningModel && temperature !== 1) {
    completionOptions.temperature = temperature;
  }

  // OpenRouter normalizes reasoning controls for namespaced models.
  if (isReasoningModel) {
    completionOptions.reasoning = { effort: reasoningEffort };
    completionOptions.verbosity = verbosity;
  }

  if (schema) {
    const jsonSchema = structuredOutputSchema(schema);
    completionOptions.response_format = {
      type: 'json_schema',
      json_schema: {
        name: 'response',
        schema: jsonSchema,
        strict: true,
      },
    };
  }

  if (enforceContextBudget) {
    await resolveModelContextCapacity(provider, capacityModel);
    fitInstanceRequest({ provider, model: capacityModel, messages, tools: completionOptions.tools || [],
      responseFormat: completionOptions.response_format });
  }
  if (onContextUsage) {
    try {
      await onContextUsage({ system: system || '', messages, tools: completionOptions.tools || [],
        provider, model: capacityModel, responseFormat: completionOptions.response_format });
    } catch (error) {
      console.warn('[AI EXECUTOR] Context usage checkpoint unavailable:', executionBoundary ? { redacted: true } : error);
    }
  }
  return completionOptions;
}
