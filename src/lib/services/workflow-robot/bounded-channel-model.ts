import OpenAI from 'openai';
import { CreditService } from '@/lib/services/billing/CreditService';
import type { WorkflowPlanResult, WorkflowPlanResultCapture } from './plan-result';

const MODEL_TIMEOUT_MS = 90_000;

export class ChannelModelTurnError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly terminalRun = false) {
    super(message);
    this.name = 'ChannelModelTurnError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** All billing identifiers come from the tenant-bound, persisted run, not model output. */
export interface ChannelTurnBilling {
  siteId: string;
  runPlanId: string;
  instanceId: string;
  stepId: string;
  messageId: string;
  attempt: number;
}

function configuredProvider(provider: string): { client: OpenAI; model: string } {
  const options = { maxRetries: 0, timeout: MODEL_TIMEOUT_MS };
  if (provider === 'azure') {
    const endpoint = process.env.MICROSOFT_AZURE_OPENAI_ENDPOINT?.replace(/\/$/, '');
    const key = process.env.MICROSOFT_AZURE_OPENAI_API_KEY;
    const deployment = process.env.MICROSOFT_AZURE_OPENAI_DEPLOYMENT || 'gpt-4o';
    if (!endpoint || !key) throw new ChannelModelTurnError('Azure provider is not configured', false, true);
    return { client: new OpenAI({ ...options, apiKey: key, baseURL: `${endpoint}/openai/deployments/${deployment}`,
      defaultQuery: { 'api-version': process.env.MICROSOFT_AZURE_OPENAI_API_VERSION || '2024-08-01-preview' },
      defaultHeaders: { 'api-key': key } }), model: process.env.AI_MODEL || deployment };
  }
  if (provider === 'openai') {
    if (!process.env.OPENAI_API_KEY) throw new ChannelModelTurnError('OpenAI provider is not configured', false, true);
    return { client: new OpenAI({ ...options, apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1' }), model: process.env.AI_MODEL || 'gpt-4o' };
  }
  if (provider === 'gemini') {
    if (!process.env.GEMINI_API_KEY) throw new ChannelModelTurnError('Gemini provider is not configured', false, true);
    return { client: new OpenAI({ ...options, apiKey: process.env.GEMINI_API_KEY,
      baseURL: process.env.GEMINI_OPENAI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai/' }),
    model: process.env.AI_MODEL || 'gemini-3.1-pro-preview' };
  }
  throw new ChannelModelTurnError('Channel message model provider is unsupported', false, true);
}

async function chargeUsage(
  usage: OpenAI.CompletionUsage | undefined, billing: ChannelTurnBilling, provider: string, model: string,
): Promise<void> {
  if (!usage || !Number.isFinite(usage.prompt_tokens) || usage.prompt_tokens < 0 ||
    !Number.isFinite(usage.completion_tokens) || usage.completion_tokens < 0) {
    throw new ChannelModelTurnError('Provider token usage is unavailable; billing requires reconciliation', false, true);
  }
  const inputTokens = usage.prompt_tokens;
  const outputTokens = usage.completion_tokens;
  const amount = inputTokens / 1_000_000 * CreditService.PRICING.ASSISTANT_INPUT_TOKEN_MILLION +
    outputTokens / 1_000_000 * CreditService.PRICING.ASSISTANT_OUTPUT_TOKEN_MILLION;
  if (amount === 0) return;
  try {
    const charged = await CreditService.deductCredits(billing.siteId, amount, 'assistant_tokens',
      `Channel workflow execution (${inputTokens + outputTokens} tokens)`, {
        site_id: billing.siteId, instance_id: billing.instanceId, plan_id: billing.runPlanId,
        run_plan_id: billing.runPlanId, step_id: billing.stepId, message_id: billing.messageId,
        attempt: billing.attempt, retry_count: billing.attempt - 1, provider, model,
        tokens: inputTokens + outputTokens, input_tokens: inputTokens, output_tokens: outputTokens,
      });
    if (charged.success !== true) throw new Error('Credit deduction was not confirmed');
  } catch {
    // The RPC might have committed before its response was lost. Never charge or execute it again.
    throw new ChannelModelTurnError('Channel workflow credit deduction failed; billing requires reconciliation', false, true);
  }
}

/** One abortable provider request. Known retryable failures are scheduled by the durable runner. */
export async function boundedChannelModelTurn(input: {
  prompt: string; userContent: string; capture: WorkflowPlanResultCapture;
  billing: ChannelTurnBilling; provider?: string; beforeProvider?: () => Promise<void>;
}): Promise<WorkflowPlanResult> {
  try {
    if (!await CreditService.validateCredits(input.billing.siteId, 0.001)) {
      throw new Error('Insufficient credits');
    }
  } catch {
    throw new ChannelModelTurnError('Insufficient credits or credit validation unavailable for channel workflow', false, true);
  }
  const provider = input.provider || process.env.ROBOT_SDK_PROVIDER || 'gemini';
  const { client, model } = configuredProvider(provider);
  // Credit validation is asynchronous; recheck ownership immediately before invoking the provider.
  await input.beforeProvider?.();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
  let completion: OpenAI.Chat.Completions.ChatCompletion;
  try {
    completion = await client.chat.completions.create({
      model, stream: false,
      messages: [{ role: 'system', content: input.prompt }, { role: 'user', content: input.userContent }],
      tools: [{ type: 'function', function: {
        name: input.capture.tool.name, description: input.capture.tool.description,
        parameters: input.capture.tool.parameters,
      } }],
      tool_choice: { type: 'function', function: { name: 'plan_result' } }, max_tokens: 2048,
    }, { signal: controller.signal, timeout: MODEL_TIMEOUT_MS, maxRetries: 0 });
  } catch (error) {
    const status = (error as { status?: number } | null)?.status;
    // Transport failures/timeouts have an unknown provider outcome and are never replayed.
    const knownFailure = typeof status === 'number' && status >= 400 && status <= 599 && status !== 408;
    const retryable = knownFailure && (status === 409 || status === 429 || status >= 500);
    throw new ChannelModelTurnError(knownFailure ? `Channel model provider returned HTTP ${status}`
      : 'Channel model provider outcome is unknown; the turn will not be replayed', retryable, !knownFailure);
  } finally {
    clearTimeout(timer);
  }

  // Usage is billable even for missing tools, malformed JSON, rejected output, and explicit failures.
  // A crash after charging leaves the durable step in_progress: reconciliation must not recharge it.
  await chargeUsage(completion.usage, input.billing, provider, model);
  const calls = completion.choices[0]?.message?.tool_calls || [];
  if (calls.length !== 1 || calls[0].type !== 'function' || calls[0].function.name !== 'plan_result') {
    throw new ChannelModelTurnError('A single plan_result call is required', true);
  }
  let args: unknown;
  try { args = JSON.parse(calls[0].function.arguments); }
  catch { throw new ChannelModelTurnError('Invalid plan_result arguments', true); }
  const acceptance = await input.capture.tool.execute(args);
  const result = input.capture.getResult();
  if (acceptance.accepted !== true || !result) {
    throw new ChannelModelTurnError(`plan_result was rejected: ${String(acceptance.error || 'Invalid result').slice(0, 400)}`, true);
  }
  return result;
}