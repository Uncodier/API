import { NextRequest, NextResponse } from 'next/server';
import { getRequestOptions } from '@/lib/config/analyzer-config';
import { handleIncompleteJsonResponse } from '@/lib/utils/api-utils';
import { createOpenRouterClient, getOpenRouterChatModel } from '@/lib/services/ai/openrouter';

export async function POST(request: NextRequest) {
  try {
    const { messages, modelType = 'openai', modelId } = await request.json();
    if (!Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json({ error: 'Se requiere un array de mensajes' }, { status: 400 });
    }
    if (modelId !== undefined && typeof modelId !== 'string') {
      return NextResponse.json({ error: 'modelId debe ser un string' }, { status: 400 });
    }

    // modelType is a model-vendor hint, never a credential or gateway selector.
    const modelOptions = getRequestOptions(modelType, modelId).openrouter;
    const response = await createOpenRouterClient().chat.completions.create({
      ...modelOptions,
      messages,
      stream: false,
    });
    // Preserve the canonical choices envelope and provider/id/usage (including cost).
    const processed = await handleIncompleteJsonResponse(response, messages, modelType, modelOptions.model);
    return NextResponse.json(processed);
  } catch {
    // SDK errors can contain authorization headers and upstream request bodies.
    console.error('[AI API] OpenRouter request failed');
    return NextResponse.json({ error: 'Error al procesar la solicitud de OpenRouter' }, { status: 500 });
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