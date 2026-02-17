import { NextRequest, NextResponse } from 'next/server';
import { continueJsonGeneration, isIncompleteJson, attemptJsonRepair } from '@/lib/services/continuation-service';

/**
 * Endpoint para continuar la generación de un JSON incompleto
 * 
 * Este endpoint recibe un JSON incompleto y utiliza un modelo de IA para completarlo.
 * Es útil cuando un agente se queda sin contexto y no puede completar la respuesta.
 */
export async function POST(req: NextRequest) {
  console.log('[API Continuation] Received request');
  
  try {
    // Obtener el cuerpo de la solicitud
    const body = await req.json();
    
    // Validar los campos requeridos
    if (!body.incompleteJson) {
      console.error('[API Continuation] Missing required field: incompleteJson');
      return NextResponse.json(
        { error: 'Missing required field: incompleteJson' },
        { status: 400 }
      );
    }
    
    if (!body.modelType) {
      console.error('[API Continuation] Missing required field: modelType');
      return NextResponse.json(
        { error: 'Missing required field: modelType' },
        { status: 400 }
      );
    }
    
    if (!body.modelId) {
      console.error('[API Continuation] Missing required field: modelId');
      return NextResponse.json(
        { error: 'Missing required field: modelId' },
        { status: 400 }
      );
    }
    
    if (!body.siteUrl) {
      console.error('[API Continuation] Missing required field: siteUrl');
      return NextResponse.json(
        { error: 'Missing required field: siteUrl' },
        { status: 400 }
      );
    }
    
    // Verificar si el JSON ya es válido
    if (!isIncompleteJson(body.incompleteJson)) {
      console.log('[API Continuation] The provided JSON is already valid');
      
      try {
        const parsedJson = JSON.parse(body.incompleteJson);
        return NextResponse.json({
          success: true,
          completeJson: parsedJson,
          message: 'The provided JSON is already valid'
        });
      } catch (error) {
        // Esto no debería ocurrir ya que isIncompleteJson ya verificó que es válido
        console.error('[API Continuation] Unexpected error parsing valid JSON:', error);
      }
    }
    
    // Intentar reparar el JSON primero (solución rápida)
    const repairedJson = attemptJsonRepair(body.incompleteJson);
    if (repairedJson) {
      console.log('[API Continuation] Successfully repaired JSON without AI');
      return NextResponse.json({
        success: true,
        completeJson: repairedJson,
        message: 'JSON was repaired without AI assistance'
      });
    }
    
    console.log('[API Continuation] Attempting to continue JSON generation with AI');
    
    // Continuar la generación del JSON con IA
    const result = await continueJsonGeneration({
      incompleteJson: body.incompleteJson,
      modelType: body.modelType,
      modelId: body.modelId,
      siteUrl: body.siteUrl,
      includeScreenshot: body.includeScreenshot || false,
      timeout: body.timeout || 45000,
      maxRetries: body.maxRetries || 3,
      debugMode: body.debugMode || false
    });
    
    if (result.success) {
      console.log('[API Continuation] Successfully completed JSON generation');
      return NextResponse.json({
        success: true,
        completeJson: result.completeJson,
        retries: result.retries,
        message: 'JSON generation completed successfully'
      });
    } else {
      console.error('[API Continuation] Failed to complete JSON generation:', result.error);
      return NextResponse.json(
        {
          success: false,
          error: result.error,
          retries: result.retries,
          message: 'Failed to complete JSON generation'
        },
        { status: 500 }
      );
    }
  } catch (error: any) {
    console.error('[API Continuation] Unexpected error:', error);
    return NextResponse.json(
      { error: `Unexpected error: ${error.message || 'Unknown error'}` },
      { status: 500 }
    );
  }
}

/**
 * Endpoint para verificar si un JSON está incompleto
 */
export async function GET(req: NextRequest) {
  try {
    // Obtener el JSON de los parámetros de consulta
    const jsonString = req.nextUrl.searchParams.get('json');
    
    if (!jsonString) {
      return NextResponse.json(
        { error: 'Missing required query parameter: json' },
        { status: 400 }
      );
    }
    
    // Verificar si el JSON está incompleto
    const incomplete = isIncompleteJson(jsonString);
    
    return NextResponse.json({
      incomplete,
      message: incomplete ? 'The provided JSON is incomplete or invalid' : 'The provided JSON is valid'
    });
  } catch (error: any) {
    console.error('[API Continuation] Unexpected error in GET:', error);
    return NextResponse.json(
      { error: `Unexpected error: ${error.message || 'Unknown error'}` },
      { status: 500 }
    );
  }
} 