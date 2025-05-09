/**
 * Clase utilitaria para procesar respuestas a los targets
 */
export class TargetResponseProcessor {
  /**
   * Procesa la respuesta de los targets
   */
  static processTargetResponse(response: any, targets: any[]): any[] {
    try {
      // Check if the target is expecting a string
      const isTargetString = targets.length > 0 && 
        (typeof targets[0].content === 'string' || 
         (targets[0].type && typeof targets[0][targets[0].type] === 'string'));
      
      // If response is a string and target expects a string, return it directly
      if (typeof response === 'string' && isTargetString) {
        return targets.map(target => {
          const targetType = target.type || Object.keys(target)[0];
          return {
            type: targetType,
            content: response
          };
        });
      }
      
      // If response is a string and target expects JSON, try to parse it
      if (typeof response === 'string' && !isTargetString) {
        try {
          response = JSON.parse(response);
        } catch (e) {
          console.warn('[TargetResponseProcessor] Failed to parse response as JSON:', e);
        }
      }

      // Log target and response structure for debugging
      console.log('[TargetResponseProcessor] Target structure:', JSON.stringify(targets[0], null, 2).substring(0, 200) + '...');
      console.log('[TargetResponseProcessor] Response structure:', 
        typeof response === 'string' 
          ? response.substring(0, 200) + '...' 
          : JSON.stringify(response, null, 2).substring(0, 200) + '...'
      );

      // Direct structure match check - if response already matches target structure exactly
      if (!Array.isArray(response) && targets.length === 1) {
        const targetKeys = Object.keys(targets[0]);
        const responseKeys = Object.keys(response);
        
        // Check for direct structure match
        const structureMatches = targetKeys.every(key => responseKeys.includes(key)) && 
                               responseKeys.every(key => targetKeys.includes(key));
        
        if (structureMatches) {
          console.log('[TargetResponseProcessor] Direct structure match detected, using response as-is');
          return [response];
        }
      }

      // No transformation - strict validation only
      if (Array.isArray(response) && response.length === targets.length) {
        // Validate with our strict validation
        const isValid = TargetResponseProcessor.validateResultsStructure(response, targets);
        if (isValid) {
          return response;
        } else {
          console.warn('[TargetResponseProcessor] Response failed strict validation, falling back to default results');
          return TargetResponseProcessor.createDefaultResults(targets);
        }
      }
      
      // If direct usage failed, fall back to manual mapping
      return targets.map((target, index) => {
        // Get the first key in the target object - for special handling
        const targetKeys = Object.keys(target);
        
        // Special handling for objects like { "message": { ... } }
        if (targetKeys.length === 1 && typeof target[targetKeys[0]] === 'object') {
          const key = targetKeys[0];
          
          // Direct pass-through for matched structure from the LLM
          if (!Array.isArray(response)) {
            // If LLM already returned the correct structure with the key, use it directly
            if (response[key]) {
              console.log(`[TargetResponseProcessor] Found exact structure match for key "${key}", using directly`);
              return { [key]: response[key] };
            }
          }
        }

        const targetType = target.type || Object.keys(target)[0];
        
        // Try to extract content from response that matches this target
        let content;
        
        if (Array.isArray(response) && index < response.length) {
          // If we have an array response, use the matching index item
          content = response[index].content || response[index];
        } else if (!Array.isArray(response) && index === 0) {
          // For non-array responses, use entire response for first target
          content = response;
        } else {
          // For additional targets without matching response data
          content = "No se pudo obtener una respuesta. Por favor, inténtelo de nuevo más tarde.";
        }
        
        // Special handling for array content to ensure structure alignment
        if (targetType === 'contents' && Array.isArray(target.content)) {
          // Basic structure preservation - ensure array structure is maintained
          if (!Array.isArray(content)) {
            content = [content]; // Wrap non-array content in array to preserve structure
            console.log('[TargetResponseProcessor] Content wrapped in array to preserve structure');
          }
          
          return {
            type: 'contents',
            contents: content // Use 'contents' property name to match target
          };
        }
        
        // For content arrays in general, preserve array structure if target has array
        if (Array.isArray(target.content) && !Array.isArray(content)) {
          content = [content]; // Wrap non-array content in array to preserve structure
          console.log('[TargetResponseProcessor] Content wrapped in array to preserve structure');
        }
        
        // Return result with exact same structure as target
        return {
          type: targetType,
          content: content
        };
      });
      
    } catch (error) {
      console.error('[TargetResponseProcessor] Error processing response:', error);
      return TargetResponseProcessor.createDefaultResults(targets);
    }
  }

  /**
   * Valida que la estructura de los resultados coincida con la estructura de los targets
   * @param results Resultados procesados
   * @param targets Targets originales
   * @returns true si la estructura es válida, false en caso contrario
   */
  static validateResultsStructure(results: any[], targets: any[]): boolean {
    if (!Array.isArray(results) || !Array.isArray(targets)) {
      console.warn('[TargetResponseProcessor] Los resultados o targets no son arrays');
      return false;
    }

    // Verificar que la longitud de los arrays coincida
    if (results.length !== targets.length) {
      console.warn(`[TargetResponseProcessor] La longitud de los resultados (${results.length}) no coincide con la longitud de los targets (${targets.length})`);
      return false;
    }

    console.log(`[TargetResponseProcessor] Validating ${results.length} results against ${targets.length} targets`);

    // Comparar cada resultado con su target correspondiente
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      const result = results[i];
      
      // Simple structural validation - only check top-level properties match
      const targetKeys = Object.keys(target);
      const resultKeys = Object.keys(result);
      
      console.log(`[TargetResponseProcessor] Target keys: ${targetKeys.join(', ')}`);
      console.log(`[TargetResponseProcessor] Result keys: ${resultKeys.join(', ')}`);
      
      // Special handling for exact matches: If target has only one object property like {"message": {...}}
      if (targetKeys.length === 1 && typeof target[targetKeys[0]] === 'object') {
        const key = targetKeys[0];
        
        // Check if result has the same key
        if (result[key]) {
          console.log(`[TargetResponseProcessor] Direct structure match detected for key "${key}"`);
          // Consider this a valid match
          continue;
        }
      }
      
      // Require exact top-level property match - all properties must be the same
      for (const key of targetKeys) {
        if (!resultKeys.includes(key)) {
          console.warn(`[TargetResponseProcessor] La estructura no coincide - falta la propiedad "${key}" en el resultado`);
          return false;
        }
      }
      
      for (const key of resultKeys) {
        if (!targetKeys.includes(key)) {
          console.warn(`[TargetResponseProcessor] La estructura no coincide - la propiedad "${key}" en el resultado no existe en el target`);
          return false;
        }
      }
      
      // Verify basic type matching for each property
      for (const key of targetKeys) {
        const targetValue = target[key];
        const resultValue = result[key];
        
        // Only check type matching between primitive types or arrays
        if (Array.isArray(targetValue) !== Array.isArray(resultValue)) {
          console.warn(`[TargetResponseProcessor] La estructura de la propiedad "${key}" no coincide: uno es array y el otro no`);
          return false;
        }
        
        // If not arrays, check that primitive types match
        if (!Array.isArray(targetValue) && typeof targetValue !== typeof resultValue) {
          console.warn(`[TargetResponseProcessor] El tipo de la propiedad "${key}" no coincide: target=${typeof targetValue}, result=${typeof resultValue}`);
          return false;
        }
      }
    }

    console.log('[TargetResponseProcessor] All structure validations passed successfully');
    return true;
  }

  /**
   * Crea resultados por defecto para los targets
   * @param targets Targets originales
   * @returns Array de resultados por defecto
   */
  static createDefaultResults(targets: any[]): any[] {
    return targets.map(target => {
      // Check if target has a "type" field directly
      if (target.type) {
        return {
          type: target.type,
          content: "No se pudo obtener una respuesta. Por favor, inténtelo de nuevo más tarde."
        };
      }
      
      // Get the first key in the target object
      const targetKeys = Object.keys(target);
      
      // If we have a target structure like { "message": { "content": "example" } }
      if (targetKeys.length === 1 && typeof target[targetKeys[0]] === 'object') {
        // Maintain the exact same structure as the original target
        const key = targetKeys[0];
        return {
          [key]: {
            content: "No se pudo obtener una respuesta. Por favor, inténtelo de nuevo más tarde."
          }
        };
      }
      
      // Fall back to the old approach
      return {
        type: targetKeys[0],
        content: "No se pudo obtener una respuesta. Por favor, inténtelo de nuevo más tarde."
      };
    });
  }
} 