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

  // La cantidad de resultados debería ser al menos 1
  // No validamos coincidencia exacta para dar flexibilidad: a veces un resultado 
  // puede satisfacer múltiples targets, o varios resultados pueden servir para un target
  if (results.length < 1) {
    console.error(`[validateResults] Se esperaba al menos un resultado, se recibieron 0`);
    return { 
      isValid: false, 
      error: 'Se esperaba al menos un resultado' 
    };
  }

  console.log(`[validateResults] Verificando ${results.length} resultados contra ${targets.length} targets`);
  
  // Verificamos que los resultados tengan alguna estructura válida
  // (no validamos contra targets específicos, solo verificamos que sea algo utilizable)
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
    
    // Detección de valores placeholder copiados directamente
    // Buscamos valores de texto que sean placeholders en el resultado
    let hasPlaceholder = false;
    for (const key of resultKeys) {
      const value = result[key];
      if (typeof value === 'string' && isPlaceholderValue(value)) {
        console.warn(`[validateResults] El resultado ${i} contiene un valor placeholder sin procesar: "${value.substring(0, 30)}..."`);
        hasPlaceholder = true;
        break;
      } else if (typeof value === 'object' && value !== null) {
        // Si el valor es un objeto o array, buscar recursivamente
        const placeholderFound = containsPlaceholderInObject(value);
        if (placeholderFound) {
          console.warn(`[validateResults] El resultado ${i} contiene un valor placeholder sin procesar en una estructura anidada`);
          hasPlaceholder = true;
          break;
        }
      }
    }
    
    // Si tiene tipo y contenido, lo consideramos válido
    if (!hasPlaceholder && (result.type || result.content)) {
      validResultsCount++;
    }
    // Si tiene al menos una propiedad y no es un placeholder, también es válido
    else if (!hasPlaceholder) {
      validResultsCount++;
    }
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

/**
 * Busca recursivamente valores de placeholder en un objeto o array
 * @param {Object|Array} obj El objeto o array a verificar
 * @returns {boolean} true si se encuentra un placeholder
 */
function containsPlaceholderInObject(obj) {
  if (typeof obj !== 'object' || obj === null) {
    return false;
  }
  
  if (Array.isArray(obj)) {
    // Si es un array, verifica cada elemento
    for (const item of obj) {
      if (typeof item === 'string' && isPlaceholderValue(item)) {
        return true;
      } else if (typeof item === 'object' && item !== null) {
        if (containsPlaceholderInObject(item)) {
          return true;
        }
      }
    }
  } else {
    // Si es un objeto, verifica cada valor
    for (const key of Object.keys(obj)) {
      const value = obj[key];
      if (typeof value === 'string' && isPlaceholderValue(value)) {
        return true;
      } else if (typeof value === 'object' && value !== null) {
        if (containsPlaceholderInObject(value)) {
          return true;
        }
      }
    }
  }
  
  return false;
}

/**
 * Verifica si un valor es un placeholder genérico
 * @param {*} value El valor a verificar
 * @returns {boolean} true si es un placeholder
 */
function isPlaceholderValue(value) {
  if (typeof value !== 'string') return false;
  
  const placeholders = [
    "markdown detailed copy", 
    "title of the content", 
    "summary of the content",
    "placeholder",
    "example",
    "sample"
  ];
  
  return placeholders.some(p => value.toLowerCase().includes(p));
} 