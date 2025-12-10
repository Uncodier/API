/**
 * validateResults.js
 * Servicio para validar que los resultados generados por el TargetProcessor
 * cumplan con la estructura requerida por los targets.
 */

/**
 * Lista de propiedades que indican que un objeto es una definición de target
 * en lugar de contenido real
 */
const TARGET_DEFINITION_PROPERTIES = [
  'deep_thinking',
  'refined_content',
  'follow_up_content',
  'analysis',
  'reasoning',
  'thought_process'
];

/**
 * Detecta si un array de resultados contiene objetos de definición de targets
 * en lugar del contenido real
 * @param {Array} results Los resultados a verificar
 * @returns {boolean} true si se detecta una estructura malformada
 */
function detectMalformedTargetArray(results) {
  if (!Array.isArray(results) || results.length === 0) {
    return false;
  }

  // Contar cuántos objetos en el array tienen propiedades de definición de target
  let malformedCount = 0;

  for (const result of results) {
    if (typeof result !== 'object' || result === null) {
      continue;
    }

    const keys = Object.keys(result);

    // Si el objeto tiene exactamente una propiedad y es una propiedad de definición de target
    if (keys.length === 1 && TARGET_DEFINITION_PROPERTIES.includes(keys[0])) {
      malformedCount++;
    }

    // Si el objeto solo tiene propiedades de definición de target (sin contenido real)
    const hasOnlyTargetProps = keys.every(key => TARGET_DEFINITION_PROPERTIES.includes(key));
    if (hasOnlyTargetProps && keys.length > 0) {
      malformedCount++;
    }
  }

  // Si más del 50% de los objetos son definiciones de target, considerarlo malformado
  return malformedCount > 0 && malformedCount >= results.length * 0.5;
}

/**
 * Extrae el contenido real de una estructura malformada que contiene
 * objetos de definición de targets
 * @param {Array} results Los resultados malformados
 * @param {Array} targets Los targets originales para comparar estructura
 * @returns {Array} Los resultados corregidos con el contenido extraído
 */
function extractNestedContent(results, targets = []) {
  if (!Array.isArray(results)) {
    return results;
  }

  const extractedContent = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const correspondingTarget = targets[i];

    if (typeof result !== 'object' || result === null) {
      // Si no es un objeto, mantenerlo como está
      extractedContent.push(result);
      continue;
    }

    const keys = Object.keys(result);

    // Si el objeto tiene una sola propiedad que es una definición de target,
    // verificar si esta estructura coincide con el target correspondiente
    if (keys.length === 1 && TARGET_DEFINITION_PROPERTIES.includes(keys[0])) {
      const targetKey = keys[0];
      const nestedValue = result[targetKey];

      // 🔧 FIX: Si el target correspondiente tiene la misma estructura (una key con objeto anidado),
      // entonces esta es la estructura CORRECTA, no malformada. No extraer.
      if (correspondingTarget && typeof correspondingTarget === 'object') {
        const targetKeys = Object.keys(correspondingTarget);
        // Si el target tiene exactamente la misma estructura (una key que coincide),
        // preservar la estructura original
        if (targetKeys.length === 1 && targetKeys[0] === targetKey && 
            typeof correspondingTarget[targetKey] === 'object' && 
            !Array.isArray(correspondingTarget[targetKey])) {
          // Esta es la estructura correcta, mantenerla tal cual
          extractedContent.push(result);
          console.log(`[extractNestedContent] Estructura correcta preservada para '${targetKey}' (coincide con target)`);
          continue;
        }
      }

      // Si el valor anidado es un objeto o array válido, y NO coincide con el target,
      // entonces sí es malformado y debemos extraer
      if (nestedValue && (typeof nestedValue === 'object' || Array.isArray(nestedValue))) {
        // Si es un array, expandirlo
        if (Array.isArray(nestedValue)) {
          extractedContent.push(...nestedValue);
        } else {
          extractedContent.push(nestedValue);
        }
        console.log(`[extractNestedContent] Extraído contenido de propiedad '${targetKey}' (estructura no coincide con target)`);
        continue;
      }
    }

    // Buscar propiedades que contengan el contenido real
    let foundContent = false;
    for (const key of keys) {
      // Si encontramos una propiedad que NO es de definición de target,
      // y contiene un objeto o array, es probablemente el contenido real
      if (!TARGET_DEFINITION_PROPERTIES.includes(key)) {
        const value = result[key];
        if (value && typeof value === 'object') {
          if (Array.isArray(value)) {
            extractedContent.push(...value);
          } else {
            extractedContent.push(value);
          }
          foundContent = true;
          console.log(`[extractNestedContent] Extraído contenido de propiedad '${key}'`);
          break;
        }
      }
    }

    // Si no encontramos contenido específico, mantener el objeto original
    // pero sin las propiedades de definición de target
    if (!foundContent) {
      const cleanedResult = {};
      let hasContent = false;

      for (const key of keys) {
        if (!TARGET_DEFINITION_PROPERTIES.includes(key)) {
          cleanedResult[key] = result[key];
          hasContent = true;
        }
      }

      if (hasContent) {
        extractedContent.push(cleanedResult);
      }
    }
  }

  return extractedContent.length > 0 ? extractedContent : results;
}

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

  // 🔍 NUEVA VALIDACIÓN: Detectar estructura malformada con objetos de definición de targets
  // 🔧 FIX: Solo detectar como malformado si la estructura NO coincide con los targets
  let correctedResults = null;
  if (detectMalformedTargetArray(results)) {
    // Verificar si la estructura realmente es malformada comparándola con los targets
    const isActuallyMalformed = results.some((result, index) => {
      if (typeof result !== 'object' || result === null) return false;
      const target = targets[index];
      if (!target || typeof target !== 'object') return true; // Sin target para comparar, considerar malformado
      
      const resultKeys = Object.keys(result);
      const targetKeys = Object.keys(target);
      
      // Si el resultado tiene una sola key que es una propiedad de target definition
      if (resultKeys.length === 1 && TARGET_DEFINITION_PROPERTIES.includes(resultKeys[0])) {
        // Verificar si el target tiene la misma estructura
        if (targetKeys.length === 1 && targetKeys[0] === resultKeys[0]) {
          // Estructura coincide con target, NO es malformado
          return false;
        }
      }
      return true; // Estructura no coincide, es malformado
    });

    if (isActuallyMalformed) {
      console.warn(`[validateResults] ⚠️ ESTRUCTURA MALFORMADA DETECTADA: Los resultados contienen objetos de definición de targets en lugar de contenido real`);
      console.log(`[validateResults] Intentando extraer contenido anidado...`);

      const extracted = extractNestedContent(results, targets);

      if (extracted && Array.isArray(extracted) && extracted.length > 0) {
        console.log(`[validateResults] ✅ Contenido extraído exitosamente: ${extracted.length} elementos`);
        correctedResults = extracted;
        results = extracted; // Usar los resultados corregidos para la validación
      } else {
        console.error(`[validateResults] ❌ No se pudo extraer contenido válido de la estructura malformada`);
      }
    } else {
      console.log(`[validateResults] ✅ Estructura detectada como correcta (coincide con targets), no extrayendo`);
    }
  }

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

    // Si se corrigieron los resultados, incluirlos en la respuesta
    if (correctedResults) {
      return {
        isValid: true,
        correctedResults: correctedResults
      };
    }

    return { isValid: true };
  }

  // Si llegamos aquí, no hay resultados válidos
  return {
    isValid: false,
    error: `Ningún resultado cumple con los criterios mínimos de validez`
  };
}

// Removemos las funciones de detección de placeholders ya que pueden ser demasiado estrictas