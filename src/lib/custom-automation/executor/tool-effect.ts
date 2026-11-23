import { observedToolName } from '@/lib/connectors/connector-observation';
import type { Tool, ToolCall, ActOptions } from './types';
import { runBoundaryHook } from './boundary';

/** One admitted tool effect. Boundary/enforceSingleTurn calls must never be retried. */
export async function invokeTool(tool: Tool, toolCall: ToolCall,
  { enforceSingleTurn, executionBoundary, toolOverrides, preserveToolExecution }: ActOptions) {
  const loggedName = observedToolName(toolCall.toolName);
  let result: any;

  // Execute wait actions locally instead of round-trip to Scrapybara.
  if (!executionBoundary && !preserveToolExecution && toolCall.toolName === 'computer' && toolCall.args.action === 'wait') {
    const duration = toolCall.args.duration || 1000;
    console.log(`⚡ [WAIT_LOCAL] Executing wait locally for ${duration}ms instead of calling Scrapybara`);

    await new Promise(resolve => setTimeout(resolve, duration));

    result = `Waited for ${duration}ms`;
    console.log(`⚡ [WAIT_LOCAL] Local wait completed`);
  } else {
    const isScrapybaraTool = ['computer', 'bash', 'edit'].includes(toolCall.toolName);

    if (isScrapybaraTool) {
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ [SCRAPYBARA] Calling ${loggedName}.execute() with Scrapybara SDK...`);
    } else {
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ [LOCAL] Executing ${loggedName}.execute() locally...`);
    }

    // --- FORCE OVERRIDES FOR TOOLS ROUTER ---
    if (!executionBoundary && toolCall.toolName === 'tools' && toolCall.args.action === 'call') {
      const targetToolName = toolCall.args.name;
      if (targetToolName && toolOverrides?.[targetToolName]) {
        try {
          const innerArgs = typeof toolCall.args.args === 'string' ? JSON.parse(toolCall.args.args) : (toolCall.args.args || {});
          const mergedArgs = { ...innerArgs, ...toolOverrides[targetToolName] };
          toolCall.args.args = JSON.stringify(mergedArgs);
          console.log(`[AI EXECUTOR] Force-injected tool overrides`);
        } catch (e) {
          console.warn(`[AI EXECUTOR] Could not inject tool overrides`);
        }
      }
    }

    let executeAttempts = 0;
    const maxExecuteAttempts = executionBoundary || enforceSingleTurn || preserveToolExecution ? 1 : 2;
    while (executeAttempts < maxExecuteAttempts) {
      try {
        if (executionBoundary) {
          // Even a wrapper invoking execute twice cannot repeat an effect.
          let execution: Promise<any> | undefined;
          result = await runBoundaryHook(() => executionBoundary.executeTool({
            id: toolCall.toolCallId, name: toolCall.toolName, args: toolCall.args,
          }, () => execution ??= Promise.resolve().then(() => tool.execute(toolCall.args))));
        } else {
          result = await tool.execute(toolCall.args);
        }
        break;
      } catch (e: any) {
        if (e?.name === 'OpenRouterBillingError') throw e;
        if (e?.name === 'RecoveryError') throw e;
        executeAttempts++;
        const msg = e.message || '';
        const isTransient = msg.includes('410') || msg.includes('422') || msg.includes('sandbox_stopping') || msg.includes('timeout') || msg.includes('socket');
        if (isTransient && executeAttempts < maxExecuteAttempts) {
          console.warn(`⚠️ [TOOL_RETRY] ${loggedName} transient error. Retrying (${executeAttempts}/${maxExecuteAttempts})...`);
          await new Promise(res => setTimeout(res, 2000 * executeAttempts));
        } else {
          throw e;
        }
      }
    }

    if (result === undefined || result === null) {
      const logPrefix = isScrapybaraTool ? '[SCRAPYBARA]' : '[LOCAL]';
      console.warn(`⚠️ ${logPrefix} ${loggedName} returned ${result === undefined ? 'undefined' : 'null'}`);
    } else if (typeof result === 'object') {
      const keyCount = Object.keys(result).length;
      const logPrefix = isScrapybaraTool ? '[SCRAPYBARA]' : '[LOCAL]';
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ ${logPrefix} Result is object with ${keyCount} fields`);

      if (isScrapybaraTool && !executionBoundary) {
        if (result.error && result.error.length > 0) {
          console.error(`⚠️ [SCRAPYBARA] Error field contains: "${result.error}"`);
        }

        if (result.output && result.output.length > 0) {
          console.log(`₍ᐢ•(ܫ)•ᐢ₎ [SCRAPYBARA] Output: "${result.output.substring(0, 200)}"`);
        }

        if (result.failed || result.success === false) {
          console.error(`⚠️ [SCRAPYBARA] Result indicates failure:`, result.failed || 'success=false');
        }

        if (toolCall.args.action !== 'take_screenshot' &&
            (!result.output || result.output === '') &&
            (!result.error || result.error === '')) {
          console.warn(`⚠️ [SCRAPYBARA] ${toolCall.args.action} returned empty output and error - action may not have executed`);
          console.warn(`⚠️ [SCRAPYBARA] This usually indicates the browser window lost focus or X11 display has input issues`);
          console.warn(`⚠️ [SCRAPYBARA] Full result keys:`, Object.keys(result).join(', '));
        }

        if (result.system) {
          console.log(`₍ᐢ•(ܫ)•ᐢ₎ [SCRAPYBARA] System info:`, JSON.stringify(result.system));

          if (typeof result.system === 'object') {
            if (result.system.error || result.system.message || result.system.status) {
              console.error(`🚨 [SCRAPYBARA_SYSTEM] System field indicates issue:`, result.system);
            }
          }
        }
      }
    } else {
      const logPrefix = isScrapybaraTool ? '[SCRAPYBARA]' : '[LOCAL]';
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ ${logPrefix} Result type: ${typeof result}, length: ${String(result).length}`);
    }
  }
  return result;
}
