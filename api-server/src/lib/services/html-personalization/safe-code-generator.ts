/**
 * Generador de código seguro para personalizaciones HTML
 * 
 * Este módulo provee funciones para generar código JavaScript seguro
 * sin problemas de escape de caracteres especiales o secuencias inválidas.
 */

import { PersonalizationModification, PersonalizationImplementation } from './types';

/**
 * Genera código JavaScript seguro para aplicar personalizaciones HTML
 * 
 * @param personalizations Lista de modificaciones de personalización
 * @param minified Indica si el código debe ser minificado
 * @returns Implementación con código JavaScript seguro
 */
export function generateSafeJavaScriptImplementation(
  personalizations: PersonalizationModification[],
  minified: boolean = true
): PersonalizationImplementation {
  if (minified) {
    return generateMinifiedSafeImplementation(personalizations);
  } else {
    return generateFormattedSafeImplementation(personalizations);
  }
}

/**
 * Sanitiza una cadena para uso seguro en JavaScript
 * Maneja adecuadamente caracteres especiales, saltos de línea y comillas
 */
function sanitizeStringForJavaScript(input: string): string {
  if (!input) return '';
  
  return input
    .replace(/\\/g, '\\\\')        // Escapar backslashes primero
    .replace(/"/g, '\\"')          // Escapar comillas dobles
    .replace(/\n/g, ' ')           // Convertir saltos de línea en espacios
    .replace(/\r/g, ' ')           // Convertir retornos de carro en espacios
    .replace(/\t/g, ' ')           // Convertir tabulaciones en espacios
    .trim();                       // Eliminar espacios iniciales y finales
}

/**
 * Genera código JavaScript minificado y seguro
 */
function generateMinifiedSafeImplementation(
  personalizations: PersonalizationModification[]
): PersonalizationImplementation {
  // Crear un script sencillo sin problemas de escape
  let code = '(function(){';
  
  // Función para encontrar y manipular elementos según su operación
  code += `
function findAndOperate(s,c,o){try{const e=document.querySelector(s);if(!e)return false;
switch(o){case"remove":e.parentNode&&e.parentNode.removeChild(e);break;
case"append":const t=document.createElement("div");t.innerHTML=c;
while(t.firstChild)e.appendChild(t.firstChild);break;
case"rewrite":e.textContent=c;break;
default:e.innerHTML=c}return true}catch(e){return false}}
`;
  
  // Agregar cada personalización con formato seguro
  personalizations.forEach((p) => {
    const safeSelector = sanitizeStringForJavaScript(p.selector);
    const safeContent = sanitizeStringForJavaScript(p.after_html || '');
    
    code += `findAndOperate("${safeSelector}","${safeContent}","${p.operation_type}");`;
  });
  
  // Cerrar la función auto-ejecutable
  code += '})();';
  
  return {
    type: 'javascript',
    code
  };
}

/**
 * Genera código JavaScript formateado y seguro (no minificado)
 */
function generateFormattedSafeImplementation(
  personalizations: PersonalizationModification[]
): PersonalizationImplementation {
  // Crear el código con formato
  let code = `// Site Analyzer Personalization Script
// Generated: ${new Date().toISOString()}
// Personalizations: ${personalizations.length}

(function() {
  // Función principal para encontrar y manipular elementos
  function findAndOperate(selector, content, operationType) {
    try {
      const element = document.querySelector(selector);
      if (!element) {
        console.warn('[Personalization] Element not found: ' + selector);
        return false;
      }
      
      // Aplicar la operación según el tipo
      switch (operationType) {
        case 'remove':
          // Eliminar el elemento
          if (element.parentNode) {
            element.parentNode.removeChild(element);
            console.log('[Personalization] Removed element: ' + selector);
          }
          break;
          
        case 'append':
          // Añadir contenido al elemento
          const tempDiv = document.createElement('div');
          tempDiv.innerHTML = content;
          
          // Añadir cada hijo individualmente
          while (tempDiv.firstChild) {
            element.appendChild(tempDiv.firstChild);
          }
          console.log('[Personalization] Appended content to: ' + selector);
          break;
          
        case 'rewrite':
          // Reescribir solo el texto del elemento
          element.textContent = content;
          console.log('[Personalization] Rewrote text content: ' + selector);
          break;
          
        case 'replace':
        default:
          // Reemplazar el contenido del elemento
          element.innerHTML = content;
          console.log('[Personalization] Modified: ' + selector);
          break;
      }
      
      return true;
    } catch (error) {
      console.error('[Personalization] Error processing ' + selector + ':', error);
      return false;
    }
  }

  // Aplicar personalizaciones al cargar el DOM
  document.addEventListener('DOMContentLoaded', function() {
`;

  // Agregar cada personalización
  personalizations.forEach((p, index) => {
    const safeSelector = sanitizeStringForJavaScript(p.selector);
    const safeContent = sanitizeStringForJavaScript(p.after_html || '');
    
    code += `    // ${index + 1}. Personalización para ${p.selector}\n`;
    code += `    findAndOperate("${safeSelector}", "${safeContent}", "${p.operation_type}");\n\n`;
  });

  // Cerrar el código
  code += `    console.log('[Personalization] Applied ${personalizations.length} personalizations');
  });
  
  // También ejecutar si el DOM ya está cargado
  if (document.readyState !== 'loading') {
    console.log('[Personalization] DOM already loaded, applying immediately');
    personalizations.forEach(function() {
`;

  // Agregar llamadas inmediatas para DOM ya cargado
  personalizations.forEach((p, index) => {
    const safeSelector = sanitizeStringForJavaScript(p.selector);
    const safeContent = sanitizeStringForJavaScript(p.after_html || '');
    
    code += `      findAndOperate("${safeSelector}", "${safeContent}", "${p.operation_type}");\n`;
  });

  code += `    });
  }
})();`;

  return {
    type: 'javascript',
    code
  };
}

/**
 * Limpia el código JavaScript existente para asegurar su compatibilidad
 * 
 * @param code Código JavaScript existente de personalización
 * @returns Código limpio y seguro
 */
export function sanitizeExistingCode(code: string): string {
  // Si el código está vacío, devolver código vacío seguro
  if (!code || code.trim() === '') {
    return '(function(){})();';
  }
  
  try {
    // Extraer selectores, contenidos y operaciones
    const extractResult = extractSelectorsAndContents(code);
    
    // Recrear el código usando nuestro formato seguro
    let safeCode = '(function(){';
    safeCode += `
function findAndOperate(s,c,o){try{const e=document.querySelector(s);if(!e)return false;
switch(o){case"remove":e.parentNode&&e.parentNode.removeChild(e);break;
case"append":const t=document.createElement("div");t.innerHTML=c;
while(t.firstChild)e.appendChild(t.firstChild);break;
case"rewrite":e.textContent=c;break;
default:e.innerHTML=c}return true}catch(e){return false}}
`;
    
    // Agregar cada par selector-contenido-operación
    extractResult.selectors.forEach((selector, index) => {
      const content = extractResult.contents[index] || '';
      const operation = extractResult.operations[index] || 'replace';
      
      const safeSelector = sanitizeStringForJavaScript(selector);
      const safeContent = sanitizeStringForJavaScript(content);
      
      safeCode += `findAndOperate("${safeSelector}","${safeContent}","${operation}");`;
    });
    
    // Cerrar la función
    safeCode += '})();';
    
    return safeCode;
  } catch (error) {
    console.error('Error sanitizing code:', error);
    // En caso de error, devolver un script vacío seguro
    return '(function(){})();';
  }
}

/**
 * Extrae selectores, contenidos y operaciones de un código JavaScript existente
 */
function extractSelectorsAndContents(code: string): { 
  selectors: string[], 
  contents: string[],
  operations: string[]
} {
  const selectors: string[] = [];
  const contents: string[] = [];
  const operations: string[] = [];
  
  // Regex para encontrar patrones comunes de personalización
  const patterns = [
    // Patrón para funciones findAndOperate/findAndUpdate con 3 parámetros
    /find(?:And(?:Operate|Update))\s*\(\s*["']([^"']+)["']\s*,\s*["']([^"']*)["']\s*,\s*["']([^"']*)["']\s*\)\s*;/g,
    
    // Patrón para funciones findAndUpdate con 2 parámetros (asumir 'replace')
    /findAndUpdate\s*\(\s*["']([^"']+)["']\s*,\s*["']([^"']*)["']\s*\)\s*;/g,
    
    // Patrón para document.querySelector con operación
    /(?:const|let|var)\s+e\s*=\s*document\.querySelector\(["']([^"']+)["']\);\s*(?:.*?\s+)?(?:switch\s*\(\s*["']([^"']*)["']\s*\)|e\.innerHTML\s*=\s*["']([^"']*)["'])/g,
    
    // Patrón tradicional de querySelector e innerHTML
    /document\.querySelector\(["']([^"']+)["']\)\.innerHTML\s*=\s*["']([^"']*)["']\s*;/g,
  ];
  
  // Buscar todos los patrones
  patterns.forEach((pattern, patternIndex) => {
    let match;
    while ((match = pattern.exec(code)) !== null) {
      selectors.push(match[1]);
      
      // Diferentes patrones tienen diferentes grupos
      if (patternIndex === 0) {
        // findAndOperate pattern
        contents.push(match[2]);
        operations.push(match[3]);
      } else if (patternIndex === 1) {
        // findAndUpdate pattern (2 params)
        contents.push(match[2]);
        operations.push('replace');
      } else if (patternIndex === 2) {
        // querySelector + switch pattern
        contents.push(match[3] || '');
        operations.push(match[2] || 'replace');
      } else {
        // querySelector + innerHTML pattern
        contents.push(match[2]);
        operations.push('replace');
      }
    }
  });
  
  return { selectors, contents, operations };
} 