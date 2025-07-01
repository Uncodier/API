/**
 * Service for generating static implementation code for personalizations
 * 
 * This service generates implementation code for personalizations without requiring
 * the AI to do it every time, saving tokens and improving performance.
 */

import { PersonalizationModification, PersonalizationImplementation } from './html-personalization-service';
import { generateSafeJavaScriptImplementation } from './html-personalization';

/**
 * Sanitiza una cadena para uso seguro en JavaScript
 */
function sanitizeStringForJS(input: string): string {
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
 * Generates implementation code for a set of personalization modifications
 * 
 * @param personalizations Array of personalization modifications
 * @param implementationType The type of implementation code to generate ('javascript', 'html', or 'hybrid')
 * @param minified Whether to generate minified code (default: true)
 * @returns The implementation code object
 */
export function generateImplementationCode(
  personalizations: PersonalizationModification[],
  implementationType: 'javascript' | 'html' | 'hybrid' = 'javascript',
  minified: boolean = true
): PersonalizationImplementation {
  // If there are no personalizations, return empty code
  if (!personalizations || personalizations.length === 0) {
    return {
      type: implementationType,
      code: minified ? '' : '// No personalizations to implement'
    };
  }

  // Generate code based on implementation type
  switch (implementationType) {
    case 'html':
      return generateHtmlImplementation(personalizations, minified);
    case 'hybrid':
      return generateHybridImplementation(personalizations, minified);
    case 'javascript':
    default:
      return generateJavascriptImplementation(personalizations, minified);
  }
}

/**
 * Generates JavaScript implementation code
 */
function generateJavascriptImplementation(
  personalizations: PersonalizationModification[],
  minified: boolean = true
): PersonalizationImplementation {
  // Use the safe implementation generator for both minified and formatted code
  return generateSafeJavaScriptImplementation(personalizations, minified);
}

/**
 * Generates minified JavaScript implementation code
 * @deprecated Use generateJavascriptImplementation instead which now uses safe code generation
 */
function generateMinifiedJavascriptImplementation(
  personalizations: PersonalizationModification[]
): PersonalizationImplementation {
  // Usar el generador seguro
  return generateSafeJavaScriptImplementation(personalizations, true);
}

/**
 * Generates HTML implementation code
 */
function generateHtmlImplementation(
  personalizations: PersonalizationModification[],
  minified: boolean = true
): PersonalizationImplementation {
  if (minified) {
    // Minified HTML code
    let code = '';
    
    // Add each personalization in minified form
    personalizations.forEach((p) => {
      const safeSelector = p.selector.replace(/"/g, '&quot;');
      // Use p.after_html directly without any modification
      const htmlContent = p.operation_type === 'remove' ? '' : (p.after_html || '');
      code += `<div data-personalization-id="${p.id}" data-selector="${safeSelector}" data-operation="${p.operation_type}">${htmlContent}</div>`;
    });
    
    return {
      type: 'html',
      code
    };
  }
  
  // Non-minified HTML code with comments
  let code = `<!-- Site Analyzer Personalization HTML -->
<!-- Generated: ${new Date().toISOString()} -->
<!-- Personalizations: ${personalizations.length} -->

`;

  // Add each personalization as HTML
  personalizations.forEach((p, index) => {
    // Use p.after_html directly without any modification
    const htmlContent = p.operation_type === 'remove' ? '<!-- Element will be removed -->' : (p.after_html || '<!-- No content -->');
    code += `<!-- Personalization #${index + 1}: ${p.operation_type} -->
<div data-personalization-id="${p.id}" 
     data-selector="${p.selector.replace(/"/g, '&quot;')}"
     data-operation="${p.operation_type}">
  ${htmlContent}
</div>

`;
  });

  return {
    type: 'html',
    code
  };
}

/**
 * Generates hybrid implementation code (combination of HTML and JS)
 */
function generateHybridImplementation(
  personalizations: PersonalizationModification[],
  minified: boolean = true
): PersonalizationImplementation {
  if (minified) {
    // Create minified template of personalizations
    const template = personalizations.map(p => {
      const safeSelector = sanitizeStringForJS(p.selector);
      // Preserve HTML content but with safe attribute values
      const htmlContent = p.operation_type === 'remove' ? '' : (p.after_html || '');
      return `<div data-personalization-id="${p.id}" data-selector="${safeSelector}" data-operation="${p.operation_type}">${htmlContent}</div>`;
    }).join('');
    
    // Create minified JavaScript with improved handling of operation types
    let code = `(function(){const t="${sanitizeStringForJS(template)}";`;
    code += 'function a(){const c=document.createElement("div");c.innerHTML=t;const p=c.querySelectorAll("[data-personalization-id]");';
    code += 'p.forEach(p=>{const s=p.getAttribute("data-selector");const o=p.getAttribute("data-operation");const c=p.innerHTML;';
    code += 'try{const e=document.querySelector(s);if(e){switch(o){';
    code += 'case"remove":e.parentNode&&e.parentNode.removeChild(e);break;';
    code += 'case"append":const t=document.createElement("div");t.innerHTML=c;while(t.firstChild){e.appendChild(t.firstChild)}break;';
    code += 'default:e.innerHTML=c;break;}}}catch(e){console.error("[Personalization] Error:",e)}});}';
    code += 'document.readyState==="loading"?document.addEventListener("DOMContentLoaded",a):a();';
    code += '})();';
    
    return {
      type: 'hybrid',
      code
    };
  }
  
  // Create a combination of HTML template and JavaScript to apply it
  let code = `// Site Analyzer Hybrid Personalization Script
// Generated: ${new Date().toISOString()}
// Personalizations: ${personalizations.length}

(function() {
  // HTML template containing all personalizations
  const template = \`
<div id="site-analyzer-personalizations" style="display:none;">
${personalizations.map((p, index) => {
    // Preserve HTML content exactly as is for the template
    const htmlContent = p.operation_type === 'remove' ? '<!-- Element will be removed -->' : (p.after_html || '<!-- No content -->');
    return `  <div 
    data-personalization-id="${p.id}" 
    data-selector="${p.selector.replace(/"/g, '&quot;')}"
    data-operation="${p.operation_type}">
    ${htmlContent}
  </div>`;
  }).join('\n')}
</div>
\`;

  // Function to apply personalizations
  function applyPersonalizations() {
    // Create template container
    const container = document.createElement('div');
    container.innerHTML = template;
    
    // Get all personalization elements
    const personalizations = container.querySelectorAll('[data-personalization-id]');
    
    // Apply each personalization
    personalizations.forEach(p => {
      const selector = p.getAttribute('data-selector');
      const operation = p.getAttribute('data-operation');
      const content = p.innerHTML;
      
      try {
        const targetElement = document.querySelector(selector);
        if (targetElement) {
          // Apply based on operation type
          switch (operation) {
            case 'remove':
              // Remove the element
              targetElement.parentNode.removeChild(targetElement);
              console.log('[Personalization] Removed element: ' + selector);
              break;
              
            case 'append':
              // Append content to the element
              const tempDiv = document.createElement('div');
              tempDiv.innerHTML = content;
              
              // Append each child individually
              while (tempDiv.firstChild) {
                targetElement.appendChild(tempDiv.firstChild);
              }
              console.log('[Personalization] Appended content to: ' + selector);
              break;
              
            case 'replace':
            default:
              // Replace the element's content
              targetElement.innerHTML = content;
              console.log('[Personalization] Replaced content in: ' + selector);
              break;
          }
        } else {
          console.warn('[Personalization] Element not found: ' + selector);
        }
      } catch (error) {
        console.error('[Personalization] Error applying to ' + selector + ': ', error);
      }
    });
  }

  // Apply personalizations after DOM is loaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyPersonalizations);
  } else {
    applyPersonalizations();
  }
})();
`;

  return {
    type: 'hybrid',
    code
  };
} 