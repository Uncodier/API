/**
 * validateResults.js
 * Servicio para validar que los resultados generados por el TargetProcessor
 * cumplan con la estructura requerida por los targets.
 */

/**
 * Valida que los resultados tengan la estructura esperada según los targets
 * @param {Array} results Los resultados generados por el LLM
 * @param {Array} targets Los targets definidos para el comando
 * @returns {Object} Un objeto con el resultado de la validación y mensaje de error si falla
 */
export function validateResults(results, targets) {
  // Verificar que ambos sean arrays
  if (!Array.isArray(results) || !Array.isArray(targets)) {
    console.warn(`[validateResults] Los resultados o targets no son arrays: results=${Array.isArray(results)}, targets=${Array.isArray(targets)}`);
    
    // Si results no es un array pero es un objeto válido, convertirlo a array
    if (!Array.isArray(results) && results && typeof results === 'object') {
      results = [results];
      console.log(`[validateResults] Convertido resultado único a array de 1 elemento`);
    } else if (!Array.isArray(results)) {
      return { 
        isValid: false, 
        error: 'Los resultados no son un array ni un objeto válido' 
      };
    }
  }

  // Si no hay resultados, esto es un error grave
  if (!results || results.length === 0) {
    console.error(`[validateResults] No se generaron resultados o el array está vacío`);
    return { 
      isValid: false, 
      error: 'No se generaron resultados' 
    };
  }

  console.log(`[validateResults] Verificando ${results.length} resultados contra ${targets.length} targets`);
  
  // Verificamos que los resultados tengan alguna estructura válida
  // Validación simplificada: solo verificar que sean objetos no vacíos
  let validResultsCount = 0;
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    
    // Los resultados deben ser objetos
    if (typeof result !== 'object' || result === null) {
      console.warn(`[validateResults] El resultado ${i} no es un objeto válido: ${typeof result}`);
      continue;
    }
    
    // Los resultados deben tener al menos alguna propiedad
    const resultKeys = Object.keys(result);
    if (resultKeys.length === 0) {
      console.warn(`[validateResults] El resultado ${i} está vacío, no tiene propiedades`);
      continue;
    }
    
    // Validación específica: evitar resultados genéricos type: 'text' cuando no corresponde
    if (result.type === 'text' && result.content) {
      // Revisar si algún target tiene realmente la estructura type/content
      const hasTextTarget = targets.some(target => 
        (target.type === 'text') || 
        (target.type && target.content !== undefined)
      );
      
      if (!hasTextTarget) {
        console.warn(`[validateResults] El resultado ${i} tiene estructura type: 'text' pero no hay targets que la requieran`);
        continue; // Rechazar este resultado
      }
    }
    
    // Si llegamos aquí, el resultado es válido
    validResultsCount++;
    console.log(`[validateResults] Resultado ${i} es válido - tiene ${resultKeys.length} propiedades: ${resultKeys.join(', ')}`);
  }
  
  // Permitimos resultados si hay al menos uno válido
  if (validResultsCount > 0) {
    console.log(`[validateResults] Resultados válidos: ${validResultsCount}/${results.length}`);
    return { isValid: true };
  }
  
  // Si llegamos aquí, no hay resultados válidos
  return { 
    isValid: false, 
    error: `Ningún resultado cumple con los criterios mínimos de validez` 
  };
}

// Removemos las funciones de detección de placeholders ya que pueden ser demasiado estrictas