/**
 * Token extraction and tracking utilities for ToolEvaluator
 */

/**
 * Extrae la información de uso de tokens de la respuesta de Portkey
 */
export function extractTokenUsage(response: any): { inputTokens: number, outputTokens: number } {
  const usage = { inputTokens: 0, outputTokens: 0 };
  
  try {
    console.log(`[ToolEvaluator] Examinando estructura de respuesta para tokens: ${
      JSON.stringify(
        response?.usage || 
        response?.usageMetadata || 
        (response?.metadata?.usage ? 'Tiene metadata.usage' : 'No usage data')
      ).substring(0, 200)
    }`);
    
    if (typeof response === 'object') {
      // Portkey direct format (new format)
      if (response.usageMetadata) {
        usage.inputTokens = response.usageMetadata.promptTokenCount || 0;
        usage.outputTokens = response.usageMetadata.candidatesTokenCount || 0;
        console.log(`[ToolEvaluator] Tokens detectados de usageMetadata: ${usage.inputTokens}/${usage.outputTokens}`);
      }
      // Standard format
      else if (response.usage) {
        usage.inputTokens = response.usage.input_tokens || response.usage.prompt_tokens || 0;
        usage.outputTokens = response.usage.output_tokens || response.usage.completion_tokens || 0;
        console.log(`[ToolEvaluator] Tokens detectados de usage: ${usage.inputTokens}/${usage.outputTokens}`);
      }
      // Alternate format
      else if (response.inputTokenCount !== undefined && response.outputTokenCount !== undefined) {
        usage.inputTokens = response.inputTokenCount;
        usage.outputTokens = response.outputTokenCount;
        console.log(`[ToolEvaluator] Tokens detectados de tokenCount: ${usage.inputTokens}/${usage.outputTokens}`);
      }
      // Metadata format
      else if (response.metadata && response.metadata.usage) {
        usage.inputTokens = response.metadata.usage.input_tokens || response.metadata.usage.prompt_tokens || 0;
        usage.outputTokens = response.metadata.usage.output_tokens || response.metadata.usage.completion_tokens || 0;
        console.log(`[ToolEvaluator] Tokens detectados de metadata.usage: ${usage.inputTokens}/${usage.outputTokens}`);
      }
    }
  } catch (error) {
    console.warn(`[ToolEvaluator] Error extrayendo información de uso de tokens:`, error);
    console.warn(`[ToolEvaluator] Estructura de respuesta: ${JSON.stringify(response).substring(0, 500)}`);
  }
  
  console.log(`[ToolEvaluator] Total tokens detectados - Input: ${usage.inputTokens}, Output: ${usage.outputTokens}`);
  return usage;
} 