import { observedToolName } from '@/lib/connectors/connector-observation';
import { normalizeToolOperationResult } from '@/lib/services/tool-operation-result';
import { documentResultForText } from '@/lib/agentbase/services/command/document-image-content';
import { documentVisionContent } from '@/lib/services/robot-instance/document-vision-references';
import type { ReadDocumentToolParams } from '@/app/api/agents/tools/read_document/assistantProtocol';
import { ensureAzureSafeDataImageUrl } from '../azure-vision-message-sanitize';
import type { ActOptions, Message, Step, Tool, ToolResult, AIProvider } from './types';
import { runBoundaryHook } from './boundary';
import { extractBase64Image, MAX_SCREENSHOT_HISTORY, type ScreenshotState } from './vision';
import { prepareToolCalls } from './tool-arguments';
import { invokeTool } from './tool-effect';

export async function runToolTurn(options: ActOptions, message: Message, messages: Message[], finalTools: Tool[],
  provider: AIProvider, step: Step, iterations: number, screenshots: ScreenshotState) {
  const { schema, executionBoundary, enforceSingleTurn } = options;
  const prepared = await prepareToolCalls(message, messages, finalTools, provider, options);
  if (!prepared) return 'retry_parse';
  const { toolCalls, unparseable } = prepared;
  const screenshotHistory = screenshots.history;
  step.toolCalls = toolCalls;

  console.log(`₍ᐢ•(ܫ)•ᐢ₎ [TOOLS] Executing ${toolCalls.length} tool call(s):`);
  toolCalls.forEach((tc, idx) => {
    console.log(`  ${idx + 1}. ${observedToolName(tc.toolName)} (${tc.toolCallId})`);
  });

  const toolResults: ToolResult[] = [];
  const allToolsStartTime = Date.now();

  // Collect images first, then attach them as a single user message AFTER all tool messages.
  const collectedImages: string[] = [];
  const documentFunctions: Array<{ id: string; name: string; status: string; args: ReadDocumentToolParams; result: unknown }> = [];
  let toolExecutionStarted = false;

  for (const toolCall of toolCalls) {
    const loggedName = observedToolName(toolCall.toolName);
    const toolStartTime = Date.now();
    console.log(`⏱️ [TOOL_START] ${loggedName} (${toolCall.toolCallId}) - Starting execution...`);
    const tool = finalTools.find(t => t.name === toolCall.toolName);

    if (executionBoundary) {
      const invalidArgs = unparseable.some(call => call.id === toolCall.toolCallId);
      const skipped = enforceSingleTurn && toolExecutionStarted;
      if (invalidArgs || !tool || skipped) {
        // Every approved provider ID goes through host receipt handling,
        // even when no actual tool effect is possible or allowed.
        const synthetic = { success: false, executed: false,
          ...(skipped && !invalidArgs && tool ? { status: 'skipped' } : {}),
          error: invalidArgs ? 'invalid_tool_arguments' : !tool ? 'tool_not_found' : 'single_turn_tool_limit' };
        const result = await runBoundaryHook(() => executionBoundary.executeTool({
          id: toolCall.toolCallId, name: toolCall.toolName, args: toolCall.args,
        }, async () => synthetic));
        toolResults.push({ toolCallId: toolCall.toolCallId, toolName: toolCall.toolName, result, isError: true });
        messages.push({ role: 'tool', tool_call_id: toolCall.toolCallId, name: toolCall.toolName,
          content: JSON.stringify(result) });
        continue;
      }
    }

    if (!tool) {
      const errorMsg = `Error: Tool ${toolCall.toolName} not found`;
      console.error(`₍ᐢ•(ܫ)•ᐢ₎ [TOOL_ERROR] Tool not found: ${loggedName} (${toolCall.toolCallId})`);

      toolResults.push({
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        result: errorMsg,
        isError: true,
      });

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.toolCallId,
        name: toolCall.toolName,
        content: errorMsg,
      });

      console.log(`₍ᐢ•(ܫ)•ᐢ₎ [TOOL_MSG] ✅ Added tool message for ${toolCall.toolCallId}`);

      continue;
    }

    if (enforceSingleTurn && toolExecutionStarted) {
      // Do not delete the provider's calls or leave dangling IDs: every
      // call needs a result before history can be reused on the next turn.
      const skippedResult = {
        success: false,
        status: 'skipped',
        executed: false,
        error: 'single_turn_tool_limit',
        message: 'Not executed: this turn allows only one tool execution attempt. Request this call again in a later turn if still needed.',
      };
      toolResults.push({
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        result: skippedResult,
        isError: true,
      });
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.toolCallId,
        name: toolCall.toolName,
        content: JSON.stringify(skippedResult),
      });
      continue;
    }

    // A failed attempt may already have effects. It consumes the budget
    // just like a successful invocation (including locally handled wait).
    toolExecutionStarted = true;
    try {
      const result = await invokeTool(tool, toolCall, options);
      const toolEndTime = Date.now();
      const toolDuration = toolEndTime - toolStartTime;
      console.log(`⏱️ [TOOL_END] ${loggedName} completed in ${toolDuration}ms (${(toolDuration/1000).toFixed(1)}s)`);

      // The router wraps native results. PDF images are document context,
      // not screenshots: preserve page labels and never sample them by iteration.
      const routedDocument = toolCall.toolName === 'tools' && toolCall.args.action === 'call'
        && toolCall.args.name === 'read_document' && result?.name === 'read_document';
      const isDocument = toolCall.toolName === 'read_document' || routedDocument;
      const documentResult = routedDocument ? result.result : result;
      if (isDocument) documentFunctions.push({ id: toolCall.toolCallId, name: 'read_document',
        status: 'completed', args: routedDocument
          ? (typeof toolCall.args.args === 'string' ? JSON.parse(toolCall.args.args) : toolCall.args.args)
          : toolCall.args, result: documentResult });
      const { cleanedResult, base64Image: extractedImage } = isDocument
        ? { cleanedResult: routedDocument ? { ...result, result: documentResultForText(documentResult) }
          : documentResultForText(documentResult), base64Image: null }
        : extractBase64Image(result);
      // Azure-specific data URL coercion; skip for other providers since it
      // can drop otherwise-valid PNG/JPEG payloads.
      let base64Image: string | null;
      if (provider === 'azure') {
        base64Image = extractedImage ? ensureAzureSafeDataImageUrl(extractedImage) : null;
        if (extractedImage && !base64Image) {
          console.warn(
            `₍ᐢ•(ܫ)•ᐢ₎ [TOOL_IMAGE] ${loggedName} returned image bytes not usable for Azure vision (dropped from history)`
          );
        }
      } else {
        base64Image = extractedImage;
      }

      if (base64Image) {
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ [TOOL_IMAGE] ${loggedName} returned base64 image (${base64Image.length} chars)`);

        const screenshotHash = base64Image.substring(0, 100);
        if (screenshots.lastHash === screenshotHash) {
          screenshots.identicalCount++;
          console.warn(`⚠️ [SCREENSHOT_DUPLICATE] Screenshot #${screenshots.identicalCount + 1} is identical to previous one - browser may not be responding to actions`);

          if (screenshots.identicalCount >= 3) {
            console.error(`🚨 [SCREENSHOT_DUPLICATE] ${screenshots.identicalCount + 1} consecutive identical screenshots detected!`);
            console.error(`🚨 [SCREENSHOT_DUPLICATE] Browser is likely NOT responding to computer tool actions`);
            console.error(`🚨 [SCREENSHOT_DUPLICATE] Recent actions: ${toolCalls.map(tc => observedToolName(tc.toolName)).join(', ')}`);
          }
        } else {
          if (screenshots.identicalCount > 0) {
            console.log(`✅ [SCREENSHOT_CHANGED] Screenshot changed after ${screenshots.identicalCount + 1} identical ones`);
          }
          screenshots.identicalCount = 0;
          screenshots.lastHash = screenshotHash;
        }

        collectedImages.push(base64Image);

        screenshotHistory.push(base64Image);
        if (screenshotHistory.length > MAX_SCREENSHOT_HISTORY) {
          screenshotHistory.shift();
        }
      } else {
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ [TOOL_NO_IMAGE] ${loggedName} - no image in result`);
      }

      const operation = normalizeToolOperationResult(cleanedResult ?? result);
      toolResults.push({
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        result,
        base64Image: base64Image,
        cleanedResult: cleanedResult,
        isError: operation.outcome === 'failed',
      });

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.toolCallId,
        name: toolCall.toolName,
        content: typeof cleanedResult === 'string' ? cleanedResult : JSON.stringify(cleanedResult),
      });

      console.log(`₍ᐢ•(ܫ)•ᐢ₎ [TOOL_MSG] ✅ Added tool message for ${toolCall.toolCallId}`);

    } catch (error: any) {
      if (error?.name === 'OpenRouterBillingError') throw error;
      // A lost owner or unpersisted observation is not proof the tool failed.
      // Stop the turn without retrying or inventing a failed tool reply.
      if (error?.name === 'RecoveryError') throw error;
      const toolEndTime = Date.now();
      const toolDuration = toolEndTime - toolStartTime;
      const errorMessage = error.message || String(error);
      console.error(`⏱️ [TOOL_ERROR] ${loggedName} (${toolCall.toolCallId}) failed after ${toolDuration}ms (${(toolDuration/1000).toFixed(1)}s)`);

      const toolToExecute = finalTools.find(t => t.name === toolCall.toolName);
      const helpMessage = toolToExecute?.description ? `\n\nTool Help / Instructions:\n${toolToExecute.description}` : '';

      // Preserve structured validation errors for the model, not the console.
      let structuredError: any = {
        success: false,
        error: errorMessage,
      };

      if (error.errors || error.issues) {
        const issues = error.errors || error.issues;
        structuredError.code = 'VALIDATION_ERROR';
        structuredError.details = issues;
        structuredError.hint = `Verifica los tipos de datos enviados. Los arrays no deben ir como strings anidados. Parámetros de la tool:\n${JSON.stringify(toolToExecute?.parameters || {}, null, 2)}`;
      }

      const errorContent = JSON.stringify(structuredError, null, 2) + helpMessage;

      toolResults.push({
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        result: errorContent,
        isError: true,
      });

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.toolCallId,
        name: toolCall.toolName,
        content: errorContent,
      });

      console.log(`₍ᐢ•(ܫ)•ᐢ₎ [TOOL_MSG] ✅ Added error tool message for ${toolCall.toolCallId}`);
    }
  }

  const allToolsEndTime = Date.now();
  const allToolsDuration = allToolsEndTime - allToolsStartTime;
  console.log(`⏱️ [TOOLS_TOTAL] All ${toolCalls.length} tool(s) executed in ${allToolsDuration}ms (${(allToolsDuration/1000).toFixed(1)}s)`);

  // Safety: guarantee every tool_call has a matching tool message.
  const toolMessageIds = new Set(
    messages
      .filter((m: any) => m.role === 'tool')
      .map((m: any) => m.tool_call_id)
  );

  const missingToolCallIds = toolCalls.filter(tc => !toolMessageIds.has(tc.toolCallId));

  if (missingToolCallIds.length > 0) {
    console.error(`₍ᐢ•(ܫ)•ᐢ₎ [TOOLS] ❌ CRITICAL: ${missingToolCallIds.length} tool_call_id(s) missing tool messages!`);
    missingToolCallIds.forEach(tc => {
      console.error(`₍ᐢ•(ܫ)•ᐢ₎ [TOOLS] ❌ Missing: ${tc.toolCallId} (${observedToolName(tc.toolName)})`);

      messages.push({
        role: 'tool',
        tool_call_id: tc.toolCallId,
        name: tc.toolName,
        content: `Error: Tool execution failed unexpectedly. No response recorded.`,
      });
    });
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ [TOOLS] ✅ Added emergency tool messages for missing tool_call_ids`);
  } else {
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ [TOOLS] ✅ All ${toolCalls.length} tool_call_ids have corresponding tool messages`);
  }

  const documentContent = documentVisionContent(documentFunctions);
  if (Array.isArray(documentContent)) messages.push({ role: 'user', content: documentContent } as any);

  const shouldIncludeScreenshots = iterations <= 3 || iterations % 3 === 0;

  const screenshotsToSend = screenshotHistory.length > 0 ? screenshotHistory : collectedImages;

  if (screenshotsToSend.length > 0 && shouldIncludeScreenshots) {
    const isHistorical = screenshotsToSend === screenshotHistory;
    const historyNote = isHistorical ? ` (including ${screenshotHistory.length} from history for context)` : '';
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ [SCREENSHOTS] Adding ${screenshotsToSend.length} screenshot(s)${historyNote} as single user message in iteration ${iterations}`);

    const imageContent: any[] = [
      {
        type: 'text',
        text: screenshotsToSend.length === 1
          ? 'Here is the visual result from the previous action:'
          : `Here are the last ${screenshotsToSend.length} screenshots showing the progression of actions (most recent last):`
      }
    ];

    screenshotsToSend.forEach((image, idx) => {
      imageContent.push({
        type: 'image_url',
        image_url: {
          url: image,
          detail: 'low'
        }
      });
    });

    messages.push({
      role: 'user',
      content: imageContent
    } as any);

    console.log(`₍ᐢ•(ܫ)•ᐢ₎ [SCREENSHOTS] ✅ Added user message with ${screenshotsToSend.length} image(s)`);
  } else if (screenshotsToSend.length > 0) {
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ [SCREENSHOTS_SKIP] Skipping ${screenshotsToSend.length} screenshot(s) in iteration ${iterations} to reduce content filter risk`);
  }

  step.toolResults = toolResults;

  if (schema && toolResults.length > 0 && iterations >= 8 && iterations % 2 === 0) {
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ [REMINDER] Adding gentle reminder to request structured output (iteration ${iterations})`);
    messages.push({
      role: 'user',
      content: `⚠️ REMINDER: When you complete the current step objective, provide your response in JSON format with event, step, and assistant_message fields.`
    });
  }
  return 'processed';
}
