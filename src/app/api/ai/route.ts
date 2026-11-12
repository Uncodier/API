import { NextRequest, NextResponse } from 'next/server';
import { getRequestOptions } from '@/lib/config/analyzer-config';
import { handleIncompleteJsonResponse } from '@/lib/utils/api-utils';
import { createOpenRouterClient, getOpenRouterChatModel } from '@/lib/services/ai/openrouter';
import { observeCompletedTextRequest } from '@/lib/status/text-execution-observation';
import { authorizeInferenceRequest, withHttpExecutionRouting } from '@/lib/services/ai/customer-routing-http';

export async function POST(request: NextRequest) {
  try {
    const { messages, modelType = 'openai', modelId, site_id } = await request.json();
    const { routing } = await authorizeInferenceRequest(request, site_id);
    if (!Array.isArray(messages) || messages.length === 0 || messages.length > 100 ||
      JSON.stringify(messages).length > 100000) {
      return NextResponse.json({ error: 'A bounded non-empty messages array is required' }, { status: 400 });
    }
    if (modelId !== undefined && typeof modelId !== 'string') {
      return NextResponse.json({ error: 'modelId must be a string' }, { status: 400 });
    }

    // modelType is a model-vendor hint, never a credential or gateway selector.
    const modelOptions = getRequestOptions(modelType, modelId).openrouter;
    const execute = async () => {
      const client = createOpenRouterClient();
      const response = await observeCompletedTextRequest(modelOptions.model, () => client.chat.completions.create({
        ...modelOptions, messages, stream: false,
      }));
      return NextResponse.json(await handleIncompleteJsonResponse(response, messages, modelType, modelOptions.model));
    };
    return routing ? await withHttpExecutionRouting(request, routing, execute) : await execute();
  } catch (error: any) {
    // SDK errors can contain authorization headers and upstream request bodies.
    console.error('[AI API] OpenRouter request failed');
    return NextResponse.json({ error: 'Unable to process inference request' }, { status: error?.status ?? 500 });
  }
}

export async function GET() {
  return NextResponse.json({
    message: 'API de IA',
    gateway: 'openrouter',
    usage: 'Envía un POST con messages y opcionalmente modelType/modelId',
    example: {
      messages: [{ role: 'user', content: 'Hola, ¿puedes ayudarme con mi sitio web?' }],
      modelType: 'openai',
      modelId: getOpenRouterChatModel(),
    },
    available_providers: ['openai', 'anthropic', 'gemini'],
    documentation: '/api/docs',
  });
}